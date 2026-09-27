/*
 * analyzer.js —— 注入到 sandbox 预览 iframe 内执行的分析脚本。
 *
 * 职责：
 *  1. 依据 tabindex / disabled / hidden / inert / 计算样式 / DOM 嵌套，
 *     按「组合树（composed tree）」推导文档中所有候选可聚焦元素的 Tab
 *     （Shift+Tab 为其逆序）顺序：展开 open shadowRoot、按 <slot> 分配
 *     渲染轻 DOM 节点、未分配时使用 fallback，并跳过未分配的宿主轻 DOM；
 *  2. 为每个节点生成可往返定位的「分段选择器」（跨 shadow 边界 / slot
 *     分配）与节点身份（唯一 id + 含宿主链的结构/属性指纹），供步进、
 *     列表点击、编辑后位置恢复与「基线对比」使用；
 *  3. closed shadow root 明确标记为「不可检查」：不猜测其内部焦点顺序，
 *     宿主轻 DOM 节点列为「不可确定」，并给出诊断；
 *  4. 模态焦点陷阱审计：在组合树范围内识别可见 dialog[open] /
 *     aria-modal="true" 容器，拆分「模态内循环」与「模态外泄漏」；
 *  5. 视觉顺序审计：采集 Tab 顺序节点的实际矩形（getBoundingClientRect）
 *     与最近滚动容器，仅比较同一滚动容器内可明确排序的节点，按行与文档
 *     LTR/RTL 方向建立视觉顺序，找出与 Tab 路线相邻却逆向跳转的焦点对；
 *     零尺寸 / 矩形重叠 / 行归属不唯一 / 跨滚动容器的节点标为无法判定，
 *     不计作无偏差；
 *  6. 控件名称审计：限 button / a[href] / input[type=text]，名称按
 *     aria-labelledby → aria-label → 原生 label（文本框）→ 内容（按钮/链接）
 *     → title 取首个非空结果并折叠空白；ID 引用 / label 关联仅在控件所属
 *     Document/ShadowRoot 内解析，多引用按声明顺序拼接，缺失 ID 给出诊断，
 *     引用重复 ID 时无法判定；文本沿 open Shadow DOM / slot 组合树读取，
 *     忽略未分配轻 DOM，直接引用的隐藏节点取整棵子树文字，普通内容跳过
 *     hidden / display:none / visibility:hidden 子树，引用目标不再追随
 *     aria-labelledby；
 *  7. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics /
 * pickActiveModal / computeModalCycle / buildModalDiagnostics /
 * parseRoute / formatRoute / buildShadowDiagnostics / auditVisualOrder /
 * isNameAuditTarget / collapseWhitespace / pickNameSource /
 * buildNameAuditDiagnostics）不依赖 DOM，会在 Node 环境下导出，供单元测试使用。
 */
(function () {
  'use strict';

  /* ===================== 纯函数（可单测） ===================== */

  /**
   * 解析 tabindex 属性原始值。
   * @param {string|null} raw 属性原始值（无属性时传 null）
   * @returns {{has:boolean, valid:boolean, value:(number|null), raw:(string|null)}}
   */
  function parseTabIndexValue(raw) {
    if (raw === null || raw === undefined) {
      return { has: false, valid: false, value: null, raw: null };
    }
    var trimmed = String(raw).trim();
    var valid = /^[+-]?\d+$/.test(trimmed);
    return {
      has: true,
      valid: valid,
      value: valid ? parseInt(trimmed, 10) : null,
      raw: String(raw)
    };
  }

  /**
   * 依据 HTML 顺序聚焦导航模型计算 Tab 顺序：
   *  1. tabindex 为正整数的元素，按数值升序，平局按组合树先后；
   *  2. 其余（tabindex=0 或天然可聚焦）按组合树先后。
   * status 为 'excluded' / 'programmatic'（tabindex<0）的节点不进入顺序。
   *
   * @param {Array<{status:string, tabIndex:number, domIndex:number}>} entries
   * @returns {number[]} entries 的下标数组，即 Tab 顺序
   */
  function computeOrder(entries) {
    var positives = [];
    var zeros = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.status !== 'ordered') continue;
      if (e.tabIndex > 0) positives.push(i);
      else zeros.push(i);
    }
    positives.sort(function (a, b) {
      return entries[a].tabIndex - entries[b].tabIndex || entries[a].domIndex - entries[b].domIndex;
    });
    zeros.sort(function (a, b) {
      return entries[a].domIndex - entries[b].domIndex;
    });
    return positives.concat(zeros);
  }

  /**
   * 汇总全局诊断信息（顺序异常与可访问性提示）。
   * @param {Array} entries 节点数组（含 status/tabIndex/reasons/warnings/tag/interactive）
   * @param {number[]} order computeOrder 的结果
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function buildDiagnostics(entries, order) {
    var diags = [];
    var i, e;

    // 正值 tabindex：顺序异常的主要来源
    var positives = entries.filter(function (x) { return x.status === 'ordered' && x.tabIndex > 0; });
    if (positives.length > 0) {
      diags.push({
        level: 'warn',
        code: 'positive-tabindex',
        message: '检测到 ' + positives.length + ' 个元素使用正值 tabindex（' +
          positives.map(function (x) { return x.label + '=' + x.tabIndex; }).join('，') +
          '）。它们会被排到所有自然顺序元素之前，通常应改用合理的 DOM 顺序。'
      });
    }

    // 正值 tabindex 撞号：按组合树顺序决胜
    var byValue = {};
    positives.forEach(function (x) {
      byValue[x.tabIndex] = byValue[x.tabIndex] || [];
      byValue[x.tabIndex].push(x.label);
    });
    Object.keys(byValue).forEach(function (v) {
      if (byValue[v].length > 1) {
        diags.push({
          level: 'info',
          code: 'duplicate-tabindex',
          message: 'tabindex=' + v + ' 被 ' + byValue[v].length + ' 个元素共用（' +
            byValue[v].join('，') + '），平局按组合树先后排序。'
        });
      }
    });

    // tabindex<0：可编程聚焦但不在 Tab 顺序中
    var programmatic = entries.filter(function (x) { return x.status === 'programmatic'; });
    if (programmatic.length > 0) {
      diags.push({
        level: 'info',
        code: 'negative-tabindex',
        message: programmatic.length + ' 个元素 tabindex 为负数（' +
          programmatic.map(function (x) { return x.label; }).join('，') +
          '）：可通过脚本 / 点击聚焦，但不会出现在 Tab 顺序中。'
      });
    }

    // 被排除节点统计
    var excluded = entries.filter(function (x) { return x.status === 'excluded'; });
    if (excluded.length > 0) {
      diags.push({
        level: 'info',
        code: 'excluded-count',
        message: excluded.length + ' 个候选元素被排除在 Tab 顺序之外，原因见「排除与诊断」列表。'
      });
    }

    // 非交互元素设置 tabindex
    var nonInteractive = entries.filter(function (x) {
      return x.status === 'ordered' && x.hasTabindexAttr && !x.interactive;
    });
    if (nonInteractive.length > 0) {
      diags.push({
        level: 'info',
        code: 'non-interactive-tabindex',
        message: nonInteractive.length + ' 个非交互元素（' +
          nonInteractive.map(function (x) { return x.label; }).join('，') +
          '）通过 tabindex 进入 Tab 顺序，请确认它们确实需要键盘聚焦。'
      });
    }

    // 节点级 warning 透传
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var ws = e.warnings || [];
      for (var j = 0; j < ws.length; j++) {
        diags.push({ level: ws[j].level || 'warn', code: ws[j].code, message: e.label + '：' + ws[j].message });
      }
    }

    if (order.length === 0) {
      diags.push({ level: 'warn', code: 'empty-order', message: '当前文档没有任何可 Tab 聚焦的元素。' });
    }
    return diags;
  }

  /* ---------------- 分段选择器（跨边界、可往返） ---------------- */

  /**
   * 跨 shadow 边界 / slot 分配的定位路径由若干「段」组成：
   *  - { t:'L', css } 在文档轻树内按 css 定位（首段，css 从 html 起）；
   *  - { t:'S', css } 进入上一元素的 open shadowRoot，在其中按 css 定位；
   *  - { t:'T', css } 上一元素为 <slot>：取其分配的轻 DOM 节点，
   *    css 相对于宿主（host.querySelector 作用域）。
   * 序列化形式（作为 selector 字符串在父页面 / 基线 / 导出中原样往返）：
   *   "L:html > body > x-list >> S:ul > slot[name=items] >> T:li:nth-of-type(2) > button"
   * 分隔符 " >> " 不是合法 CSS，可无歧义切分。
   */
  function formatRoute(segments) {
    return (segments || []).map(function (s) { return s.t + ':' + s.css; }).join(' >> ');
  }

  function parseRoute(str) {
    if (!str) return [];
    var out = [];
    String(str).split(' >> ').forEach(function (part) {
      var t = part.charAt(0);
      if (t === 'L' || t === 'S' || t === 'T') {
        out.push({ t: t, css: part.slice(2) });
      }
    });
    return out;
  }

  /* ---------------- Shadow DOM 诊断（纯函数） ---------------- */

  /**
   * @param {{openCount:number, closed:Array<{label:string}>, unassignedCount:number,
   *          suppressedFallbackCount:number}} info
   */
  function buildShadowDiagnostics(info) {
    var diags = [];
    if (!info) return diags;
    if (info.openCount > 0) {
      diags.push({
        level: 'info',
        code: 'shadow-open',
        message: '检测到 ' + info.openCount + ' 个 open Shadow Root：Tab 路线已按组合树展开 ' +
          '（shadow 内部节点、slot 分配节点与未分配 slot 的 fallback 内容均计入，宿主轻 DOM 不重复计算）。'
      });
    }
    (info.closed || []).forEach(function (c) {
      diags.push({
        level: 'warn',
        code: 'shadow-closed',
        message: '检测到 closed Shadow Root（宿主 ' + c.label +
          '）：闭合边界内部（slot 分配、内部焦点）不可检查，实验室不猜测其内部 Tab 顺序；' +
          '其轻 DOM 子节点在列表中标记为「不可确定」。'
      });
    });
    if (info.unassignedCount > 0) {
      diags.push({
        level: 'info',
        code: 'shadow-unassigned',
        message: info.unassignedCount + ' 个宿主轻 DOM 候选节点未被任何 <slot> 分配，' +
          '不进入组合树渲染，因此不参与 Tab 顺序（见「排除与诊断」）。'
      });
    }
    if (info.suppressedFallbackCount > 0) {
      diags.push({
        level: 'info',
        code: 'slot-fallback-suppressed',
        message: info.suppressedFallbackCount + ' 个 slot fallback 候选节点因该 slot 已分配其他节点而不渲染。'
      });
    }
    return diags;
  }

  /* ---------------- 模态焦点陷阱审计（纯函数） ---------------- */

  /**
   * 从可见模态候选中选出「活动模态」的下标。
   * 规则：嵌套时只取最内层（不包含其他候选者）；同级并列时取 DOM 序最后者
   * （后出现的模态通常位于顶层）。候选数组须按文档序排列。
   * @param {Array<{containsCandidate:boolean}>} candidates
   * @returns {number} 活动模态下标，无可用候选时为 -1
   */
  function pickActiveModal(candidates) {
    var pick = -1;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && candidates[i].containsCandidate) continue;
      pick = i;
    }
    return pick;
  }

  /**
   * 依据全局 Tab 顺序拆分「模态内循环」与「模态外泄漏」。
   * @param {Array<{status:string, inModal:boolean}>} entries 节点（仅需 status 与 inModal 字段）
   * @param {number[]} order computeOrder 的结果（entries 下标数组）
   * @returns {{cycle:number[], leaks:number[]}} 两组 entries 下标，均保持全局 Tab 顺序
   */
  function computeModalCycle(entries, order) {
    var cycle = [];
    var leaks = [];
    for (var i = 0; i < order.length; i++) {
      var idx = order[i];
      var e = entries[idx];
      if (!e || e.status !== 'ordered') continue;
      if (e.inModal) cycle.push(idx); else leaks.push(idx);
    }
    return { cycle: cycle, leaks: leaks };
  }

  /**
   * 模态焦点陷阱审计诊断（纯函数）。
   */
  function buildModalDiagnostics(info) {
    var diags = [];
    if (!info || !info.hasModal) return diags;
    var kindLabel = info.kind === 'dialog' ? '<dialog open>' : 'aria-modal="true"';

    diags.push({
      level: 'info',
      code: 'modal-active',
      message: '活动模态 ' + info.label + '（' + kindLabel + '）：模态内循环 ' +
        info.cycleCount + ' 个节点，模态外泄漏 ' + info.leakCount + ' 个。'
    });

    if (info.cycleCount === 0) {
      diags.push({
        level: 'warn',
        code: 'modal-no-focusable',
        message: '活动模态内没有任何可 Tab 聚焦的元素，焦点陷阱无法形成循环，键盘用户将无法操作模态内容。'
      });
    }

    if (!info.hasAccessibleName) {
      diags.push({
        level: 'warn',
        code: 'modal-no-name',
        message: '活动模态缺少可访问名称：请添加 aria-label 或 aria-labelledby（至少提供 title），否则屏幕阅读器用户无法理解该模态的用途。'
      });
    }

    if (info.leakCount > 0) {
      var labels = (info.leakLabels || []).slice(0, 5).join('，');
      diags.push({
        level: 'warn',
        code: 'modal-leak',
        message: info.leakCount + ' 个模态外节点仍可 Tab 到达（' + labels +
          (info.leakCount > 5 ? ' 等' : '') + '），焦点可从模态中泄漏；' +
          '应对模态外内容设置 inert 或移除其 Tab 可达性。' +
          (info.kind === 'dialog'
            ? '（若该 <dialog> 以 showModal() 打开，浏览器会自动屏蔽外部节点；此处按静态可聚焦性列出。）'
            : '')
      });
    }

    if (info.candidateCount > 1) {
      diags.push({
        level: 'info',
        code: 'modal-multiple',
        message: '检测到 ' + info.candidateCount + ' 个可见模态容器：嵌套时仅审计最内层，同级并列时取 DOM 序最后者。'
      });
    }
    return diags;
  }

  /* ---------------- 视觉顺序审计（纯函数） ---------------- */

  /** 行归属判定的垂直重叠容差（px）：重叠高度大于该值才视为同一行 / 跨行 */
  var ROW_OVERLAP_TOLERANCE = 2;

  /** 两个矩形是否存在正面积重叠（仅共边不算重叠） */
  function rectsOverlap(r1, r2) {
    return r1.left < r2.left + r2.width && r2.left < r1.left + r1.width &&
           r1.top < r2.top + r2.height && r2.top < r1.top + r1.height;
  }

  /** 垂直区间 [aTop,aBottom] 与 [bTop,bBottom] 的重叠高度（不相交时为负） */
  function verticalOverlap(aTop, aBottom, bTop, bBottom) {
    return Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  }

  /** 几何类「无法判定」原因（节点固有，与相邻对是否跨容器无关） */
  var GEOMETRIC_REASONS = { 'zero-size': true, 'rect-overlap': true, 'row-ambiguous': true };

  /**
   * 视觉顺序审计：比较「实际视觉顺序」与「Tab 顺序」。
   *
   * @param {Array} nodes Tab 顺序中的节点（数组顺序必须就是 Tab 顺序），每个为：
   *   { step, selector, label, rect:{left,top,width,height}, container }
   *   rect 为视口坐标矩形；container 为最近滚动容器身份（同一字符串即可比较）。
   * @param {{direction?:string}} options direction 为文档方向 'ltr' / 'rtl'
   *
   * 判定规则：
   *  1. 零尺寸矩形 → 无法判定（zero-size）；
   *  2. 与同一滚动容器内其他节点的矩形正面积重叠 → 无法判定（rect-overlap）；
   *  3. 行聚类：同一容器内，垂直区间存在公共重叠（> 2px）的节点聚为一行，
   *     行带取成员垂直区间的交集（避免高节点把多行桥接成一行）；
   *     节点区间与多个最终行带重叠 → 行归属不唯一（row-ambiguous）；
   *  4. 行内按文档方向排序（LTR：左缘升序；RTL：右缘降序）得到视觉顺序；
   *  5. 仅评判「相邻 Tab 对」：
   *     · 含几何类无法判定节点的对不评判；
   *     · 两节点分属不同滚动容器 → 不评判，且两节点记 cross-scroll-container；
   *     · 同行内视觉顺序相反 → inline-backward；
   *     · 跳回更靠上的行 → row-backward；向下跳行（前进方向）不算偏差。
   *
   * @returns {{direction:string, deviations:Array, undetermined:Array, stats:object}}
   */
  function auditVisualOrder(nodes, options) {
    var direction = (options && options.direction === 'rtl') ? 'rtl' : 'ltr';

    // 归一化输入：数组顺序即 Tab 顺序；step 为节点身份（1 基 Tab 序号）
    var list = (nodes || []).map(function (n) {
      var r = (n && n.rect) || {};
      return {
        step: n && n.step,
        selector: (n && n.selector) || null,
        label: (n && n.label) || null,
        rect: {
          left: Number(r.left) || 0,
          top: Number(r.top) || 0,
          width: Number(r.width) || 0,
          height: Number(r.height) || 0
        },
        container: (n && n.container) || 'document'
      };
    });

    var deviations = [];
    var undetermined = [];
    var reasonByStep = Object.create(null); // step → 原因码（每节点只记首个原因）

    function markUndetermined(n, reason, message) {
      if (reasonByStep[n.step]) return;
      reasonByStep[n.step] = reason;
      undetermined.push({
        step: n.step,
        selector: n.selector,
        label: n.label,
        reason: reason,
        container: n.container,
        message: message
      });
    }

    function groupByContainer(arr) {
      var map = Object.create(null);
      arr.forEach(function (n) {
        (map[n.container] = map[n.container] || []).push(n);
      });
      return map;
    }

    // 1) 零尺寸矩形：无法确定视觉位置
    var sizable = [];
    list.forEach(function (n) {
      if (n.rect.width > 0 && n.rect.height > 0) sizable.push(n);
      else markUndetermined(n, 'zero-size', '节点矩形尺寸为零（未布局或已折叠），无法确定其视觉位置');
    });

    // 2) 矩形重叠：同一滚动容器内与其他节点正面积相交 → 无法明确排序
    var sizableGroups = groupByContainer(sizable);
    Object.keys(sizableGroups).forEach(function (cid) {
      var g = sizableGroups[cid];
      for (var i = 0; i < g.length; i++) {
        for (var j = i + 1; j < g.length; j++) {
          if (rectsOverlap(g[i].rect, g[j].rect)) {
            markUndetermined(g[i], 'rect-overlap',
              '节点矩形与同容器内第 ' + g[j].step + ' 步节点的矩形重叠，无法明确排序');
            markUndetermined(g[j], 'rect-overlap',
              '节点矩形与同容器内第 ' + g[i].step + ' 步节点的矩形重叠，无法明确排序');
          }
        }
      }
    });
    var clean = sizable.filter(function (n) { return !reasonByStep[n.step]; });

    // 3) 行聚类（按容器分组）：行带为成员垂直区间的公共交集；
    //    节点区间与自身行带以外的行带也重叠（> 容差）→ 行归属不唯一
    var rowOfStep = Object.create(null);    // step → 行号（0 基，按行带 top 升序）
    var visualOfStep = Object.create(null); // step → 行内视觉位次（0 基）
    var cleanGroups = groupByContainer(clean);
    Object.keys(cleanGroups).forEach(function (cid) {
      var g = cleanGroups[cid].slice().sort(function (a, b) {
        return (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left) || (a.step - b.step);
      });
      var rows = []; // { top, bottom, members }，top/bottom 为成员区间的公共交集
      g.forEach(function (n) {
        var r = n.rect;
        var bottom = r.top + r.height;
        for (var k = 0; k < rows.length; k++) {
          var row = rows[k];
          if (verticalOverlap(r.top, bottom, row.top, row.bottom) > ROW_OVERLAP_TOLERANCE) {
            row.members.push(n);
            row.top = Math.max(row.top, r.top);
            row.bottom = Math.min(row.bottom, bottom);
            return;
          }
        }
        rows.push({ top: r.top, bottom: bottom, members: [n] });
      });
      rows.forEach(function (row, ri) {
        row.members.forEach(function (n) {
          var r = n.rect;
          for (var k = 0; k < rows.length; k++) {
            if (k === ri) continue;
            if (verticalOverlap(r.top, r.top + r.height, rows[k].top, rows[k].bottom) > ROW_OVERLAP_TOLERANCE) {
              markUndetermined(n, 'row-ambiguous', '节点垂直区间跨越多行，行归属不唯一，无法确定视觉顺序');
              break;
            }
          }
        });
      });
      // 剔除无法判定成员后的最终行带，按 top 升序编号
      var finalRows = rows.map(function (row) {
        return {
          top: row.top,
          members: row.members.filter(function (n) { return !reasonByStep[n.step]; })
        };
      }).filter(function (row) { return row.members.length > 0; });
      finalRows.sort(function (a, b) { return a.top - b.top; });
      finalRows.forEach(function (row, ri) {
        // 4) 行内视觉顺序：LTR 按左缘升序，RTL 按右缘降序（平局按 top、Tab 序号）
        row.members.sort(function (a, b) {
          var d = direction === 'rtl'
            ? (b.rect.left + b.rect.width) - (a.rect.left + a.rect.width)
            : a.rect.left - b.rect.left;
          if (d !== 0) return d;
          return (a.rect.top - b.rect.top) || (a.step - b.step);
        });
        row.members.forEach(function (n, vi) {
          rowOfStep[n.step] = ri;
          visualOfStep[n.step] = vi;
        });
      });
    });

    // 5) 相邻 Tab 对评判
    var pairs = Math.max(0, list.length - 1);
    var comparablePairs = 0;
    for (var p = 0; p + 1 < list.length; p++) {
      var a = list[p];
      var b = list[p + 1];
      if (GEOMETRIC_REASONS[reasonByStep[a.step]] || GEOMETRIC_REASONS[reasonByStep[b.step]]) continue;
      if (a.container !== b.container) {
        // 跨滚动容器：对不评判，且两个节点都标为无法判定（不影响它们与同容器
        // 其他相邻节点的评判——cross-scroll-container 不是几何类原因）
        markUndetermined(a, 'cross-scroll-container',
          '与相邻 Tab 节点（第 ' + b.step + ' 步）分属不同滚动容器，跨容器视觉顺序无法判定');
        markUndetermined(b, 'cross-scroll-container',
          '与相邻 Tab 节点（第 ' + a.step + ' 步）分属不同滚动容器，跨容器视觉顺序无法判定');
        continue;
      }
      comparablePairs++;
      var ra = rowOfStep[a.step];
      var rb = rowOfStep[b.step];
      if (ra === rb) {
        var va = visualOfStep[a.step];
        var vb = visualOfStep[b.step];
        if (vb < va) {
          deviations.push({
            type: 'inline-backward',
            fromStep: a.step,
            toStep: b.step,
            fromSelector: a.selector,
            toSelector: b.selector,
            fromLabel: a.label,
            toLabel: b.label,
            fromRow: ra + 1,
            toRow: rb + 1,
            fromVisual: va + 1,
            toVisual: vb + 1,
            container: a.container,
            message: '同行逆向：第 ' + b.step + ' 步视觉上位于第 ' + a.step + ' 步的' +
              (direction === 'rtl' ? '右' : '左') + '侧（行内视觉第 ' + (vb + 1) +
              ' 个 ← 第 ' + (va + 1) + ' 个），Tab 顺序却相反'
          });
        }
      } else if (rb < ra) {
        deviations.push({
          type: 'row-backward',
          fromStep: a.step,
          toStep: b.step,
          fromSelector: a.selector,
          toSelector: b.selector,
          fromLabel: a.label,
          toLabel: b.label,
          fromRow: ra + 1,
          toRow: rb + 1,
          container: a.container,
          message: '跨行逆向：从视觉第 ' + (ra + 1) + ' 行跳回更靠上的第 ' + (rb + 1) + ' 行'
        });
      }
      // rb > ra：向下跳行（前进方向），不算偏差
    }

    undetermined.sort(function (x, y) { return x.step - y.step; });

    return {
      direction: direction,
      deviations: deviations,
      undetermined: undetermined,
      stats: {
        nodes: list.length,
        pairs: pairs,
        comparablePairs: comparablePairs,
        deviationCount: deviations.length,
        undeterminedCount: undetermined.length
      }
    };
  }

  /* ---------------- 控件名称审计（纯函数） ---------------- */

  /**
   * 控件名称审计的目标元素集合：
   *  - <button>（含 type=submit/reset/button 等全部按钮）；
   *  - 带 href 的 <a>（无 href 的锚点不算链接控件）；
   *  - 文本类 <input>：DOM 侧传入浏览器归一化后的 el.type——type 缺省 / 空串 /
   *    非法值都会被浏览器归一化为 text，因此这里只接受归一化后的 'text'，
   *    email / search / password 等显式其他类型不计。
   *
   * @param {string} tagName 标签名（大小写不敏感）
   * @param {string} [inputType] el.type 的归一化值（仅 input 有意义）
   * @param {boolean} [hasHref] 是否带 href 属性（仅 a 有意义）
   */
  function isNameAuditTarget(tagName, inputType, hasHref) {
    var tag = String(tagName || '').toLowerCase();
    if (tag === 'button') return true;
    if (tag === 'a') return !!hasHref;
    if (tag === 'input') return String(inputType || 'text').toLowerCase() === 'text';
    return false;
  }

  /** 折叠空白：制表 / 换行 / 连续空白合并为单个空格并去除首尾空白 */
  function collapseWhitespace(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * 单条 ID 引用（aria-labelledby / label[for]）的诊断信息。
   * @param {{attr:string, id:string, state:string}} ref state: 'ok'|'missing'|'duplicate'
   * @returns {{code:string, message:string}|null} ok 引用不产生诊断
   */
  function refDiagnostic(ref) {
    if (!ref) return null;
    var refLabel = ref.attr === 'label[for]' ? 'label[for] 关联' : ref.attr + ' 引用';
    if (ref.state === 'missing') {
      return {
        code: 'name-missing-id',
        message: refLabel + '的 ID "' + ref.id +
          '" 在控件所属 Document/ShadowRoot 内不存在：ID 引用不跨 shadow 边界解析'
      };
    }
    if (ref.state === 'duplicate') {
      return {
        code: 'name-duplicate-id',
        message: 'ID "' + ref.id + '" 在控件所属树作用域内对应多个节点，' +
          refLabel + '无法判定'
      };
    }
    return null;
  }

  /** 缺名诊断（按控件种类给出修复提示） */
  function missingNameReason(tagName) {
    var tag = String(tagName || '').toLowerCase();
    if (tag === 'input') {
      return {
        code: 'name-missing',
        message: '文本框缺少可访问名称：请用 <label for> 关联或用 <label> 包裹，' +
          '或添加 aria-label / aria-labelledby（至少提供 title）'
      };
    }
    var what = tag === 'a' ? '链接' : '按钮';
    return {
      code: 'name-missing',
      message: what + '缺少可访问名称：请提供可见文本内容，或添加 aria-label / ' +
        'aria-labelledby（至少提供 title）'
    };
  }

  /** refs 中非 ok 引用对应的诊断列表 */
  function brokenRefReasons(refs) {
    var out = [];
    (refs || []).forEach(function (r) {
      var d = refDiagnostic(r);
      if (d) out.push(d);
    });
    return out;
  }

  /**
   * 名称来源候选 → 最终名称。候选按优先级排列：
   * aria-labelledby → aria-label → 原生 label（文本框）→ 内容（按钮/链接）→ title。
   * 规则：
   *  - 候选 ambiguous（ID 引用命中重复 ID）→ 整个名称无法判定，立即返回歧义结果
   *    （不再回退后续来源）；
   *  - 否则取第一个折叠空白后非空的 name；其前各来源的 refs 全部保留
   *    （缺失 ID 即便已被后续来源兜底仍给出诊断）；
   *  - 全部为空 → 缺名。
   *
   * @param {Array<{source:string, name:(string|null), ambiguous:boolean, refs:Array}>} candidates
   * @param {string} tagName 控件标签名（缺名提示按种类区分）
   * @returns {{name:(string|null), source:(string|null), state:string, refs:Array, reasons:Array}}
   */
  function pickNameSource(candidates, tagName) {
    var refs = [];
    for (var i = 0; i < (candidates || []).length; i++) {
      var c = candidates[i];
      if (c.refs) Array.prototype.push.apply(refs, c.refs);
      if (c.ambiguous) {
        return { name: null, source: c.source, state: 'ambiguous', refs: refs, reasons: brokenRefReasons(refs) };
      }
      if (c.name) {
        return { name: c.name, source: c.source, state: 'named', refs: refs, reasons: brokenRefReasons(refs) };
      }
    }
    return {
      name: null,
      source: null,
      state: 'missing',
      refs: refs,
      reasons: brokenRefReasons(refs).concat([missingNameReason(tagName)])
    };
  }

  /**
   * 控件名称审计汇总诊断（纯函数）。
   * @param {Array} items pickNameSource 结果 + { tag, label, selector }
   */
  function buildNameAuditDiagnostics(items) {
    var diags = [];
    if (!items || items.length === 0) return diags;
    var missing = [];
    var ambiguous = [];
    var missingRefs = [];
    var dupRefs = [];
    items.forEach(function (it) {
      if (it.state === 'missing') missing.push(it);
      if (it.state === 'ambiguous') ambiguous.push(it);
      (it.refs || []).forEach(function (r) {
        if (r.state === 'missing') missingRefs.push({ it: it, r: r });
        if (r.state === 'duplicate') dupRefs.push({ it: it, r: r });
      });
    });

    if (missing.length > 0) {
      diags.push({
        level: 'warn',
        code: 'name-missing-count',
        message: missing.length + ' 个控件缺少可访问名称（' +
          missing.slice(0, 5).map(function (x) { return x.label; }).join('，') +
          (missing.length > 5 ? ' 等' : '') + '）。'
      });
    }
    if (ambiguous.length > 0) {
      diags.push({
        level: 'warn',
        code: 'name-ambiguous-count',
        message: ambiguous.length + ' 个控件的名称无法判定：ID 引用在控件所属树作用域内命中重复 ID（' +
          ambiguous.slice(0, 5).map(function (x) { return x.label; }).join('，') +
          (ambiguous.length > 5 ? ' 等' : '') + '），实验室不猜测其指向。'
      });
    }
    if (missingRefs.length > 0) {
      var ids = [];
      missingRefs.forEach(function (m) {
        var token = m.r.attr + ':"' + m.r.id + '"@' + m.it.label;
        if (ids.indexOf(token) < 0) ids.push(token);
      });
      diags.push({
        level: 'warn',
        code: 'name-missing-id-count',
        message: missingRefs.length + ' 处 ID 引用在控件所属 Document/ShadowRoot 内找不到节点（' +
          ids.slice(0, 5).join('，') + (ids.length > 5 ? ' 等' : '') +
          '）：ID 引用不跨 shadow 边界解析，对应名称来源被跳过。'
      });
    }
    if (dupRefs.length > 0) {
      diags.push({
        level: 'info',
        code: 'name-duplicate-id-count',
        message: dupRefs.length + ' 处 ID 引用命中了同树作用域内的重复 ID，名称按「无法判定」处理。'
      });
    }
    return diags;
  }

  // Node 环境：导出纯函数供测试，随后退出（不触碰 DOM）。
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        parseTabIndexValue: parseTabIndexValue,
        computeOrder: computeOrder,
        buildDiagnostics: buildDiagnostics,
        parseRoute: parseRoute,
        formatRoute: formatRoute,
        buildShadowDiagnostics: buildShadowDiagnostics,
        pickActiveModal: pickActiveModal,
        computeModalCycle: computeModalCycle,
        buildModalDiagnostics: buildModalDiagnostics,
        auditVisualOrder: auditVisualOrder,
        isNameAuditTarget: isNameAuditTarget,
        collapseWhitespace: collapseWhitespace,
        refDiagnostic: refDiagnostic,
        missingNameReason: missingNameReason,
        pickNameSource: pickNameSource,
        buildNameAuditDiagnostics: buildNameAuditDiagnostics
      };
    }
    return;
  }

  /* ===================== 浏览器环境：组合树分析 ===================== */

  var SOURCE = 'focus-lab'; // 消息来源标记，父子双方据此过滤消息

  // 父页面净化阶段给 closed shadow root 宿主打的标记（closed 根无法从 JS 探测，
  // 只能在声明式模板被解析前于宿主元素上留下记号）。
  var CLOSED_MARKER = 'data-focus-lab-closed-shadow';

  var entries = [];   // 全部候选节点（含被排除者）
  var order = [];     // entries 下标组成的 Tab 顺序
  var overlay = null; // 高亮框
  var badge = null;   // 高亮框上的序号角标
  var currentStep = -1;

  var allElements = [];        // 物理树全量元素（跨 open 边界，不含 closed 内部）
  var idCounts = Object.create(null);
  var openHosts = [];          // open shadow root 宿主
  var closedHosts = [];        // closed shadow root 宿主
  var unassignedSet = new Set();   // 未被任何 slot 分配的宿主轻 DOM 节点
  var undeterminedSet = new Set(); // closed 根宿主轻 DOM 中「不可确定」节点
  var suppressedFallbackSet = new Set(); // slot 已分配而不渲染的 fallback 节点
  var routeCache = new WeakMap();

  function post(msg) {
    msg.source = SOURCE;
    parent.postMessage(msg, '*'); // sandbox 下源为 opaque origin，父页面用 event.source 校验
  }

  function childrenOf(el) {
    return Array.prototype.slice.call(el.children || []);
  }

  function rootChildren(root) {
    if (root === document) return document.documentElement ? [document.documentElement] : [];
    return Array.prototype.slice.call(root.children || []);
  }

  /** 是否为可被 disabled 禁用的表单控件 */
  function isFormControl(el) {
    return /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTGROUP|OPTION)$/.test(el.tagName);
  }

  /** details 的第一个 summary 子元素 */
  function firstSummary(details) {
    for (var i = 0; i < details.children.length; i++) {
      if (details.children[i].tagName === 'SUMMARY') return details.children[i];
    }
    return null;
  }

  /** 元素是否属于「天然可聚焦」集合（未考虑 disabled/hidden 等排除项） */
  function naturallyFocusable(el) {
    switch (el.tagName) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href');
      case 'BUTTON':
      case 'SELECT':
      case 'TEXTAREA':
        return true;
      case 'INPUT':
        return el.type !== 'hidden';
      case 'IFRAME':
        return true;
      case 'AUDIO':
      case 'VIDEO':
        return el.hasAttribute('controls');
      case 'SUMMARY': {
        var p = el.parentElement;
        return !!(p && p.tagName === 'DETAILS' && firstSummary(p) === el);
      }
      default:
        break;
    }
    // contenteditable（空串 / true / plaintext-only 等，isContentEditable 已排除 "false"）
    if (el.isContentEditable) return true;
    return false;
  }

  /* ---------------- 组合树祖先遍历 ---------------- */

  /**
   * 沿物理父链向上（跨 shadow 边界时接续到宿主元素）的元素迭代。
   * slot 分配的节点物理上仍位于轻 DOM，其父链天然正确。
   */
  function forEachPhysicalAncestor(el, fn) {
    var node = el.parentElement;
    while (node) {
      fn(node);
      var parent = node.parentElement;
      if (!parent) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) {
          node = rt.host;
          continue;
        }
        break;
      }
      node = parent;
    }
  }

  /** 跨边界的 closest：物理祖先链（含 shadow 宿主）上首个匹配选择器者 */
  function composedClosest(el, selector) {
    var hit = null;
    forEachPhysicalAncestor(el, function (anc) {
      if (!hit && anc.matches && anc.matches(selector)) hit = anc;
    });
    return hit;
  }

  /**
   * 组合树包含关系（供模态审计）：container 在 target 的物理祖先链上，
   * 或 target（及其祖先）经 slot 分配后，container 位于该 slot 的祖先链上。
   */
  function containsComposed(container, target) {
    var node = target;
    while (node && node.nodeType === 1) {
      if (node === container) return true;
      // slotted 分支：该节点被分配到某个 slot，则 slot 侧的组合祖先也算
      if (node.assignedSlot && containsComposed(container, node.assignedSlot)) return true;
      var parent = node.parentElement;
      if (!parent) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) {
          if (rt.host === container) return true;
          node = rt.host;
          continue;
        }
        break;
      }
      node = parent;
    }
    return false;
  }

  /** 元素是否处于 disabled fieldset（跨 shadow 边界；首个 legend 内部除外） */
  function disabledFieldsetAncestor(el) {
    var hit = null;
    forEachPhysicalAncestor(el, function (node) {
      if (hit || node.tagName !== 'FIELDSET' || !node.hasAttribute('disabled')) return;
      var legend = null;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === 'LEGEND') { legend = node.children[i]; break; }
      }
      // legend.contains 不跨 shadow 边界：跨边界时 legend 不可能包含 el，视为命中
      if (!legend || !legend.contains(el)) hit = node;
    });
    return hit;
  }

  /** 收集元素被排除出 Tab 顺序的全部原因（沿组合树祖先链判断） */
  function exclusionReasons(el) {
    var reasons = [];
    var node, cs;

    if (el.tagName === 'INPUT' && el.type === 'hidden') {
      reasons.push({ code: 'input-hidden', message: 'input[type=hidden] 不参与聚焦' });
    }
    var hiddenHit = composedClosest(el, '[hidden]');
    if (hiddenHit) {
      reasons.push({
        code: 'hidden-attr',
        message: hiddenHit === el ? '带有 hidden 属性，未渲染' : '祖先元素带有 hidden 属性，子树未渲染'
      });
    }

    var inertHit = composedClosest(el, '[inert]');
    if (inertHit) {
      reasons.push({
        code: 'inert',
        message: inertHit === el ? '元素自身带有 inert 属性' : '祖先元素带有 inert 属性，子树（含 shadow 内部）整体不可聚焦'
      });
    }

    if (isFormControl(el) && el.hasAttribute('disabled')) {
      reasons.push({ code: 'disabled', message: '表单控件带有 disabled 属性' });
    }
    var fs = disabledFieldsetAncestor(el);
    if (fs && isFormControl(el)) {
      reasons.push({ code: 'fieldset-disabled', message: '位于 disabled 的 fieldset 内（且不在其第一个 legend 中）' });
    }

    // 闭合的 details：除第一个 summary 外，内部内容不可聚焦（沿组合树祖先链）
    var closedDetails = null;
    forEachPhysicalAncestor(el, function (anc) {
      if (!closedDetails && anc.tagName === 'DETAILS' && !anc.hasAttribute('open')) closedDetails = anc;
    });
    if (closedDetails) {
      var summary = firstSummary(closedDetails);
      if (!(summary && (summary === el || summary.contains(el)))) {
        reasons.push({ code: 'details-closed', message: '处于未展开的 details 内（仅其 summary 可聚焦）' });
      }
    }

    // 计算样式：display:none —— 自身或任一组合祖先（含 shadow 宿主）命中即不渲染
    node = el;
    while (node && node.nodeType === 1) {
      cs = getComputedStyle(node);
      if (cs.display === 'none') {
        reasons.push({
          code: 'display-none',
          message: node === el ? '计算样式 display:none' : '祖先 ' + describe(node).css + ' 的计算样式为 display:none'
        });
        break;
      }
      var p = node.parentElement;
      if (!p) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) { node = rt.host; continue; }
        break;
      }
      node = p;
    }

    // 计算样式：visibility —— 计算值已含继承与覆盖，只需检查自身
    cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      reasons.push({ code: 'visibility-hidden', message: '计算样式 visibility:' + cs.visibility });
    }

    return reasons;
  }

  /** 元素级附加警告（不影响是否可聚焦） */
  function elementWarnings(el) {
    var warnings = [];
    if (composedClosest(el, '[aria-hidden="true"]')) {
      warnings.push({
        code: 'aria-hidden-focusable',
        level: 'warn',
        message: '可聚焦元素位于 aria-hidden="true" 的子树中（含跨 shadow 边界），屏幕阅读器与键盘体验不一致'
      });
    }
    return warnings;
  }

  /** 生成简短描述：标签 + id/class + 文本片段 */
  function describe(el) {
    var css = el.tagName.toLowerCase();
    if (el.id) {
      css += '#' + el.id;
    } else if (el.classList && el.classList.length) {
      css += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    }
    if (el.tagName === 'INPUT') css += '[type=' + el.type + ']';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return { css: css, text: text };
  }

  function slotLabel(slot) {
    return slot.name ? 'slot[name=' + slot.name + ']' : 'slot（默认）';
  }

  /* ---------------- 分段选择器构造与解析 ---------------- */

  function cssEscapeIdent(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  /**
   * 在单个树作用域内的 nth-of-type 相对路径（id 唯一时短路）。
   * @param {Element} el 目标元素
   * @param {Document|ShadowRoot|Element} scope id 唯一性查询作用域
   * @param {Element?} stopAt 路径到此元素为止（不含），用于 T 段相对宿主
   */
  function localPath(el, scope, stopAt) {
    if (el.id) {
      var byId = '#' + cssEscapeIdent(el.id);
      try {
        if (scope.querySelectorAll(byId).length === 1) return byId;
      } catch (err) { /* 继续走路径方案 */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== stopAt) {
      var part = node.tagName.toLowerCase();
      // <slot> 常多个同标签并存：把 name 写入路径以保证可往返唯一定位
      if (node.tagName === 'SLOT') {
        part += node.name ? '[name="' + escFp(node.name) + '"]' : ':not([name])';
      }
      if (node.id) {
        parts.unshift('#' + cssEscapeIdent(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
        }
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (!parent) break; // shadow root 的直接子元素
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * 为任意节点（含 shadow 内部、slotted、fallback 节点）构造可往返的分段选择器。
   * 思路：从节点沿物理树向上；若节点（或祖先）经 assignedSlot 分配，则插入 T 段
   * 并改从对应 slot 继续；跨 shadow root 插入 S 段；文档轻树为 L 段。
   */
  function stableRoute(el) {
    if (routeCache.has(el)) return routeCache.get(el);
    var segments = [];
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 1000) {
      var root = cur.getRootNode();

      // 在当前物理树内寻找「被 slot 分配」的祖先（含自身）
      var assigned = null;
      for (var n = cur; n && n.nodeType === 1; n = n.parentElement) {
        if (n.assignedSlot) { assigned = n; break }
      }
      if (assigned) {
        var slot = assigned.assignedSlot;
        // T 段：相对宿主轻 DOM 的路径（宿主本身不含）
        segments.unshift({ t: 'T', css: localPath(cur, slot.getRootNode().host, slot.getRootNode().host) });
        cur = slot;
        continue;
      }

      if (root instanceof ShadowRoot) {
        segments.unshift({ t: 'S', css: localPath(cur, root, null) });
        cur = root.host;
        continue;
      }

      segments.unshift({ t: 'L', css: localPath(cur, document, null) });
      break;
    }
    var out = formatRoute(segments);
    routeCache.set(el, out);
    return out;
  }

  /** slot 的扁平化分配元素（转发链 <slot> 递归展开） */
  function flattenAssigned(slot, seen) {
    seen = seen || new Set();
    if (seen.has(slot)) return [];
    seen.add(slot);
    var out = [];
    var assigned = typeof slot.assignedElements === 'function' ? slot.assignedElements() : [];
    assigned.forEach(function (n) {
      if (n.tagName === 'SLOT') {
        out.push.apply(out, flattenAssigned(n, seen));
      } else {
        out.push(n);
      }
    });
    return out;
  }

  /** 校验 target 确实经该 slot（含转发链）分配，或为某分配节点的后代 */
  function assignedThrough(slot, target) {
    return flattenAssigned(slot).some(function (m) {
      return m === target || m.contains(target);
    });
  }

  /** 分段选择器 → 真实元素（closed 根 / 已移除节点时返回 null） */
  function resolveRoute(str) {
    var segs = parseRoute(str);
    if (segs.length === 0) return null;
    var el = null;
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      try {
        if (sg.t === 'L') {
          el = document.querySelector(sg.css);
        } else if (sg.t === 'S') {
          if (!el) return null;
          var sr = el.shadowRoot; // closed 根返回 null：明确不可定位
          if (!sr) return null;
          el = sr.querySelector(sg.css);
        } else if (sg.t === 'T') {
          if (!el || el.tagName !== 'SLOT') return null;
          var host = el.getRootNode().host;
          if (!host) return null;
          var found = host.querySelector(sg.css);
          if (!found || !assignedThrough(el, found)) return null;
          el = found;
        }
      } catch (err) {
        return null;
      }
      if (!el) return null;
    }
    return el;
  }

  /* ---------------- 节点身份（供基线对比匹配） ---------------- */

  /** 指纹字符串中的值转义，避免拼接歧义 */
  function escFp(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  }

  /** 参与指纹的关键属性（不含 tabindex/disabled/hidden 等会影响顺序或状态的属性） */
  var FP_ATTRS = ['type', 'name', 'role', 'href', 'placeholder', 'aria-label', 'title'];

  function fpTag(node) {
    var part = node.tagName.toLowerCase();
    if (node.id) part += '#' + node.id;
    return part;
  }

  /** 当前节点在本物理树内（不含自身）的祖先指纹段 */
  function fpAncestors(cur) {
    var chain = [];
    var n = cur.parentElement;
    while (n) {
      chain.unshift(fpTag(n));
      if (!n.parentElement) break;
      n = n.parentElement;
    }
    return chain;
  }

  /**
   * 结构/属性指纹：标签 + 关键属性 + 归一化文本 + 组合祖先链。
   * 祖先链带 shadow / slot 边界标记，因此不同组件内部的同构节点不会误配；
   * 刻意不含 :nth-of-type 等位置信息。
   */
  function fingerprint(el) {
    var s = el.tagName.toLowerCase();
    for (var i = 0; i < FP_ATTRS.length; i++) {
      var name = FP_ATTRS[i];
      if (el.hasAttribute(name)) {
        s += '[' + name + '="' + escFp(String(el.getAttribute(name)).slice(0, 24)) + '"]';
      }
    }
    if (el.tagName === 'INPUT' && !el.hasAttribute('type')) s += '[type="text"]';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text) s += ' "' + escFp(text) + '"';

    var parts = [];
    var cur = el;
    var prevSlot = null; // 转发链：上一跳到达的 slot，遍历其内部时不再把它算作一次分配
    var guard = 0;
    while (cur && guard++ < 1000) {
      var root = cur.getRootNode();
      // 自身 / 祖先被 slot 分配：插入 ::slotted(name) 边界标记。
      var assigned = null;
      for (var n = cur; n && n.nodeType === 1; n = n.parentElement) {
        if (n.assignedSlot && n.assignedSlot !== prevSlot) { assigned = n; break; }
      }
      if (assigned) {
        var sl = assigned.assignedSlot;
        parts.push.apply(parts, fpAncestors(assigned));
        parts.push('::slotted(' + (sl.name || '#default') + ')');
        prevSlot = sl; // 下一跳从 sl 起；忽略 sl 自身被外层再分配那一跳之外的回边
        cur = sl;
        continue;
      }
      if (root instanceof ShadowRoot) {
        parts.push.apply(parts, fpAncestors(cur));
        parts.push('::shadow');
        prevSlot = null;
        cur = root.host;
        continue;
      }
      parts.push.apply(parts, fpAncestors(cur));
      break;
    }
    s += ' ^' + parts.join('>');
    return s;
  }

  /**
   * 节点身份：
   *  - uid ：整棵组合树内唯一 id（id 缺失或跨树重复时为空）；
   *  - fp  ：含宿主链 / slot 边界的结构/属性指纹（位置无关）；
   *  - path：分段选择器（仅展示 / 排查 / 导出，不参与匹配）。
   */
  function computeIdentity(el) {
    var id = el.id ? String(el.id) : null;
    var uid = null;
    if (id && idCounts[id] === 1) uid = 'id:' + id;
    return { id: id, uid: uid, fp: fingerprint(el), path: stableRoute(el) };
  }

  /* ---------------- 组合树遍历与候选收集 ---------------- */

  function isClosedHost(el) {
    return el.hasAttribute(CLOSED_MARKER);
  }

  /** 物理树全量收集（跨 open shadow 边界；closed 内部不可达，自然停止） */
  function collectPhysical() {
    allElements = [];
    openHosts = [];
    function walkElement(el) {
      allElements.push(el);
      var sr = el.shadowRoot;
      if (sr) {
        openHosts.push(el);
        rootChildren(sr).forEach(walkElement);
      }
      childrenOf(el).forEach(walkElement);
    }
    rootChildren(document).forEach(walkElement);

    idCounts = Object.create(null);
    allElements.forEach(function (el) {
      if (el.id) idCounts[String(el.id)] = (idCounts[String(el.id)] || 0) + 1;
    });
  }

  /** 跨任意根按 id 查找（aria-labelledby 可指向 shadow 内部节点） */
  function getElementByIdAnywhere(id) {
    for (var i = 0; i < allElements.length; i++) {
      if (allElements[i].id === id) return allElements[i];
    }
    return null;
  }

  /**
   * 遍历上下文：
   *  hosts    已穿过的 shadow 宿主（外→内）
   *  slots    已穿过的 slot 事件 {slot, via:'slotted'|'forward'|'fallback'}
   *  fallback 当前是否位于某未分配 slot 的 fallback 子树中
   */
  function ctxWith(ctx, patch) {
    return {
      hosts: patch.hosts || ctx.hosts,
      slots: patch.slots || ctx.slots,
      fallback: patch.fallback !== undefined ? patch.fallback : ctx.fallback
    };
  }

  function shadowInfo(ctx, closed) {
    return {
      depth: ctx.hosts.length,
      inShadow: ctx.hosts.length > 0,
      hosts: ctx.hosts.map(function (h) {
        return { label: describe(h).css, selector: stableRoute(h) };
      }),
      slots: ctx.slots.map(function (ev) {
        return {
          name: ev.slot.name || null,
          via: ev.via,
          label: slotLabel(ev.slot),
          selector: stableRoute(ev.slot)
        };
      }),
      fallback: ctx.fallback,
      closed: !!closed
    };
  }

  /** 构建候选节点条目；forceReason 非空时强制排除（组合树状态类原因） */
  function makeEntry(el, ctx, domIndex, forceReason, closed) {
    var ti = parseTabIndexValue(el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null);
    var natural = naturallyFocusable(el);
    var hasValidTabindex = ti.has && ti.valid;
    var candidate = natural || hasValidTabindex;

    var nodeWarnings = elementWarnings(el);
    if (ti.has && !ti.valid) {
      nodeWarnings.push({
        code: 'invalid-tabindex',
        level: 'warn',
        message: 'tabindex="' + ti.raw + '" 不是合法整数，该属性被忽略'
      });
    }
    if (!candidate && nodeWarnings.length === 0) return null;

    var reasons;
    if (forceReason) {
      reasons = [forceReason];
    } else {
      reasons = exclusionReasons(el);
    }
    var effective = hasValidTabindex ? ti.value : 0;
    var status;
    if (reasons.length > 0) status = 'excluded';
    else if (effective < 0) status = 'programmatic';
    else status = 'ordered';

    var d = describe(el);
    return {
      el: el,
      status: status,
      tag: el.tagName.toLowerCase(),
      label: d.css,
      text: d.text,
      selector: stableRoute(el),
      identity: computeIdentity(el),
      tabIndex: forceReason ? null : effective,
      domIndex: domIndex,
      interactive: natural,
      hasTabindexAttr: ti.has,
      reasons: reasons,
      warnings: nodeWarnings,
      shadow: shadowInfo(ctx, closed)
    };
  }

  var domIndexSeq = 0;

  function emit(el, ctx, forceReason, closed) {
    var entry = makeEntry(el, ctx, domIndexSeq++, forceReason, closed);
    if (entry) entries.push(entry);
  }

  /** 物理子树强制标记（跨 open shadow）；用于未分配轻 DOM / fallback / closed 收集 */
  function markSubtree(el, ctx, reason, setObj, closed) {
    function walk(n, cctx) {
      setObj.add(n);
      emit(n, cctx, reason, closed);
      var sr = n.shadowRoot;
      if (sr) {
        var hctx = ctxWith(cctx, { hosts: cctx.hosts.concat([n]) });
        rootChildren(sr).forEach(function (ch) { walk(ch, hctx); });
      }
      childrenOf(n).forEach(function (ch) { walk(ch, cctx); });
    }
    walk(el, ctx);
  }

  var REASON_UNASSIGNED = {
    code: 'shadow-unassigned',
    message: 'shadow 宿主的轻 DOM 节点未被任何 <slot> 分配，不进入组合树渲染，不参与 Tab 顺序'
  };
  var REASON_FALLBACK = {
    code: 'slot-fallback-suppressed',
    message: '所在 <slot> 已分配其他节点，其 fallback 内容不渲染'
  };
  var REASON_CLOSED = {
    code: 'shadow-closed-undetermined',
    message: '位于 closed Shadow Root 宿主的轻 DOM 中：slot 分配与内部组合树不可检查，是否进入 Tab 顺序无法确定（不猜测）'
  };

  /**
   * slot 展开（可跨 shadow 边界的转发链）：
   *  - 分配节点是普通元素：在组合位置渲染它（visit 会继续其轻 DOM 子树）；
   *  - 分配节点是另一个 <slot>：
   *      · 同根转发：继续展开该 slot；
   *      · 跨 shadow 转发（内层 slot 被分配到外层 slot）：进入其所在
   *        shadowRoot，继续展开该 slot；
   *  - 无分配：渲染 fallback 子树。
   */
  function expandSlot(slot, ctx) {
    var assigned = typeof slot.assignedElements === 'function' ? slot.assignedElements() : [];
    if (assigned.length > 0) {
      assigned.forEach(function (n) {
        if (n.tagName === 'SLOT') {
          var sctx = ctxWith(ctx, { slots: ctx.slots.concat([{ slot: slot, via: 'forward' }]) });
          if (n.getRootNode() === slot.getRootNode()) {
            expandSlot(n, sctx); // 同根转发
          } else {
            // 跨 shadow 转发（内层 slot 被分配到外层 slot）：
            // n 位于已穿过的内层 shadow root，直接在同上下文继续展开 n，
            // 不再重复压入宿主。
            expandSlot(n, sctx);
          }
        } else {
          visit(n, ctxWith(ctx, { slots: ctx.slots.concat([{ slot: slot, via: 'slotted' }]) }));
        }
      });
      // slot 已占用：其 fallback 子树不渲染，登记为强制排除
      childrenOf(slot).forEach(function (ch) {
        markSubtree(ch, ctx, REASON_FALLBACK, suppressedFallbackSet, false);
      });
    } else {
      var fctx = ctxWith(ctx, {
        slots: ctx.slots.concat([{ slot: slot, via: 'fallback' }]),
        fallback: true
      });
      childrenOf(slot).forEach(function (ch) { visit(ch, fctx); });
    }
  }

  /**
   * 沿「节点 → 接收 slot → 该 slot 又被分配到外层 slot」链扁平化，
   * 返回最终接收节点所在的 slot（无则 null）。
   */
  function resolveAssignedSlot(el) {
    var node = el;
    var seen = new Set();
    while (node && node.assignedSlot && !seen.has(node)) {
      seen.add(node);
      var slot = node.assignedSlot;
      // 该 slot 自身是否又被分配到外层 slot
      if (slot.assignedSlot) { node = slot; continue; }
      return slot;
    }
    return null;
  }

  /**
   * 轻 DOM 子树是否已经在当前 shadow root 的 slot 展开阶段访问过：
   * 最终接收 slot 位于本 shadow root 即视为已访问（含转发链回到本根）；
   * 最终 slot 位于祖先根（整个宿主被转发出去）或未分配则不属于本根。
   */
  function renderedViaThisRoot(child, root) {
    var finalSlot = resolveAssignedSlot(child);
    return !!finalSlot && finalSlot.getRootNode() === root;
  }

  /** 组合树递归访问 */
  function visit(el, ctx) {
    emit(el, ctx, null, false);

    var sr = el.shadowRoot; // open 根可访问；closed 根为 null
    if (sr) {
      var hctx = ctxWith(ctx, { hosts: ctx.hosts.concat([el]) });
      rootChildren(sr).forEach(function (ch) { visit(ch, hctx); });
      // 宿主轻 DOM：经本 shadow root 内 slot（含转发链回到本根）渲染的子树已在
      // slot 展开阶段访问过；未分配 / 转发到祖先根以外的子树不渲染，登记为强制排除。
      childrenOf(el).forEach(function (ch) {
        if (renderedViaThisRoot(ch, sr)) return;
        markSubtree(ch, hctx, REASON_UNASSIGNED, unassignedSet, false);
      });
      return;
    }

    if (isClosedHost(el)) {
      if (closedHosts.indexOf(el) < 0) closedHosts.push(el);
      // 不进入闭合根；宿主轻 DOM 的 slot 分配无从得知，一律标「不可确定」
      var cctx = ctxWith(ctx, { hosts: ctx.hosts.concat([el]) });
      childrenOf(el).forEach(function (ch) {
        markSubtree(ch, cctx, REASON_CLOSED, undeterminedSet, true);
      });
      return;
    }

    if (el.tagName === 'SLOT') {
      expandSlot(el, ctx);
      return;
    }
    childrenOf(el).forEach(function (ch) { visit(ch, ctx); });
  }

  /** 宿主是否声明焦点委托：优先运行时标志（浏览器解析 DSD 后有值），
   *  回退识别宿主上的 DSD 属性 / 残留模板声明。 */
  function hostDelegatesFocus(el, sr) {
    if (sr && sr.delegatesFocus === true) return true;
    if (el.hasAttribute && el.hasAttribute('shadowrootdelegatesfocus')) return true;
    var tmpl = el.firstElementChild;
    return !!(tmpl && tmpl.tagName === 'TEMPLATE' && tmpl.hasAttribute('shadowrootdelegatesfocus'));
  }

  /** delegatesFocus 修正：宿主自身是 Tab 停靠点且 shadow 内存在有序焦点时，焦点委托 */
  function applyDelegatesFocus() {
    entries.forEach(function (en) {
      var sr = en.el.shadowRoot;
      if (!sr || !hostDelegatesFocus(en.el, sr) || en.status !== 'ordered') return;
      var hasInner = entries.some(function (o) {
        if (o === en || o.status !== 'ordered') return false;
        var rt = o.el.getRootNode();
        while (rt instanceof ShadowRoot) {
          if (rt === sr) return true;
          rt = rt.host.getRootNode();
        }
        return false;
      });
      if (hasInner) {
        en.status = 'excluded';
        en.tabIndex = null;
        en.reasons.push({
          code: 'delegates-focus',
          message: '宿主启用 delegatesFocus 且 shadow 内存在可聚焦节点：Tab 停靠位置的焦点直接委托给内部首个可聚焦节点，宿主本身不停留焦点'
        });
      }
    });
  }

  /** 扫描文档（按组合树），构建候选节点数组 */
  function buildEntries() {
    entries = [];
    unassignedSet = new Set();
    undeterminedSet = new Set();
    suppressedFallbackSet = new Set();
    closedHosts = [];
    domIndexSeq = 0;
    collectPhysical();
    visit(document.documentElement, { hosts: [], slots: [], fallback: false });
    applyDelegatesFocus();
  }

  /** 序列化（去掉 DOM 引用）后上报给父页面 */
  function serializeEntries() {
    return entries.map(function (e) {
      return {
        status: e.status,
        tag: e.tag,
        label: e.label,
        text: e.text,
        selector: e.selector,
        identity: e.identity,
        tabIndex: e.tabIndex,
        domIndex: e.domIndex,
        interactive: e.interactive,
        hasTabindexAttr: e.hasTabindexAttr,
        reasons: e.reasons,
        warnings: e.warnings,
        shadow: e.shadow,
        step: null // 稍后填充
      };
    });
  }

  /* ---------------- 模态焦点陷阱审计（DOM，跨边界） ---------------- */

  /** 容器可见性：hidden / inert 属性、display:none（组合祖先）、visibility */
  function isVisibleContainer(el) {
    if (composedClosest(el, '[hidden]')) return false;
    if (composedClosest(el, '[inert]')) return false;
    var node = el;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return false;
      var p = node.parentElement;
      if (!p) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) { node = rt.host; continue; }
        break;
      }
      node = p;
    }
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  /** 模态的可访问名称：aria-labelledby → aria-label → title（id 查找跨 shadow 边界） */
  function accessibleNameOf(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (ids) {
      var text = ids.split(/\s+/).map(function (id) {
        var t = getElementByIdAnywhere(id);
        return t ? (t.textContent || '') : '';
      }).join(' ').replace(/\s+/g, ' ').trim();
      if (text) return { name: text.slice(0, 80), source: 'aria-labelledby' };
    }
    var label = (el.getAttribute('aria-label') || '').trim();
    if (label) return { name: label.slice(0, 80), source: 'aria-label' };
    var title = (el.getAttribute('title') || '').trim();
    if (title) return { name: title.slice(0, 80), source: 'title' };
    return { name: null, source: null };
  }

  /**
   * 模态焦点陷阱审计（组合树范围）：
   *  1. 在全部 open 树中找出可见的 dialog[open] / [aria-modal="true"] 容器
   *     （未分配 / closed 不可确定子树中的容器不参与）；
   *  2. 嵌套时仅取最内层、同级并列取 DOM 序最后者作为活动模态；
   *  3. 按组合包含关系拆分「循环路线」与「泄漏」。
   */
  function computeModalAudit() {
    var candidates = [];
    var i, a, b;
    for (i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (unassignedSet.has(el) || undeterminedSet.has(el) || suppressedFallbackSet.has(el)) continue;
      var isDialog = el.tagName === 'DIALOG' && el.hasAttribute('open');
      if (!isDialog && el.getAttribute('aria-modal') !== 'true') continue;
      if (!isVisibleContainer(el)) continue;
      candidates.push({ el: el, kind: isDialog ? 'dialog' : 'aria-modal' });
    }
    // 嵌套标记：组合树中包含其他候选的容器不是「最内层」
    for (a = 0; a < candidates.length; a++) {
      candidates[a].containsCandidate = false;
      for (b = 0; b < candidates.length; b++) {
        if (a !== b && containsComposed(candidates[a].el, candidates[b].el)) {
          candidates[a].containsCandidate = true;
          break;
        }
      }
    }
    var activeIdx = pickActiveModal(candidates);
    var audit = {
      activeModal: null,
      cycle: [],
      leaks: [],
      diagnostics: [],
      candidates: candidates.map(function (c, i2) {
        return {
          kind: c.kind,
          label: describe(c.el).css,
          selector: stableRoute(c.el),
          audited: i2 === activeIdx
        };
      })
    };
    if (activeIdx < 0) return audit;

    var active = candidates[activeIdx];
    var flagged = entries.map(function (e) {
      return { status: e.status, inModal: !!(e.el && containsComposed(active.el, e.el)) };
    });
    var cl = computeModalCycle(flagged, order);
    var stepOf = {};
    for (i = 0; i < order.length; i++) stepOf[order[i]] = i + 1;
    var nameInfo = accessibleNameOf(active.el);
    var d = describe(active.el);

    audit.activeModal = {
      kind: active.kind,
      label: d.css,
      text: d.text,
      selector: stableRoute(active.el),
      identity: computeIdentity(active.el),
      accessibleName: nameInfo.name,
      nameSource: nameInfo.source
    };
    audit.cycle = cl.cycle.map(function (idx, i3) {
      var e = entries[idx];
      return {
        cycleStep: i3 + 1,
        step: stepOf[idx],
        selector: e.selector,
        label: e.label,
        text: e.text,
        tabIndex: e.tabIndex
      };
    });
    audit.leaks = cl.leaks.map(function (idx) {
      var e = entries[idx];
      return {
        step: stepOf[idx],
        selector: e.selector,
        label: e.label,
        text: e.text,
        tabIndex: e.tabIndex
      };
    });
    audit.diagnostics = buildModalDiagnostics({
      hasModal: true,
      kind: active.kind,
      label: d.css,
      cycleCount: audit.cycle.length,
      leakCount: audit.leaks.length,
      leakLabels: audit.leaks.map(function (l) { return l.label; }),
      hasAccessibleName: !!nameInfo.name,
      candidateCount: candidates.length
    });
    return audit;
  }

  function shadowStats() {
    var slotted = 0, fallback = 0;
    entries.forEach(function (e) {
      if (e.shadow.slots.some(function (ev) { return ev.via === 'slotted' || ev.via === 'forward'; })) slotted++;
      if (e.shadow.fallback) fallback++;
    });
    return {
      openRoots: openHosts.length,
      closedRoots: closedHosts.map(function (h) {
        return { label: describe(h).css, selector: stableRoute(h) };
      }),
      slottedCandidates: slotted,
      fallbackCandidates: fallback,
      unassignedCandidates: entries.filter(function (e) {
        return e.reasons.some(function (r) { return r.code === 'shadow-unassigned'; });
      }).length,
      suppressedFallbackCandidates: suppressedFallbackSet.size
    };
  }

  /* ---------------- 视觉顺序审计（DOM 采集） ---------------- */

  /** overflow 计算值为该集合之一时，元素视为滚动容器（clip-only 的 hidden 不算） */
  var SCROLLABLE_OVERFLOW = { auto: true, scroll: true, overlay: true };

  /**
   * 组合（扁平化）树父节点：被 slot 分配的节点其视觉祖先为接收 slot，
   * 其次物理父元素，shadow root 顶层元素接续到宿主。
   * 滚动裁剪沿扁平化树发生（slotted 节点可能被 shadow 内的 overflow 容器裁剪）。
   */
  function composedParent(el) {
    if (el.assignedSlot) return el.assignedSlot;
    var p = el.parentElement;
    if (p) return p;
    var rt = el.getRootNode();
    if (rt instanceof ShadowRoot) return rt.host;
    return null;
  }

  /** 最近的滚动容器（沿组合祖先链，跨 open shadow / slot 边界）；无则为文档根滚动元素 */
  function scrollContainerOf(el) {
    var node = composedParent(el);
    while (node && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      if (SCROLLABLE_OVERFLOW[cs.overflowX] || SCROLLABLE_OVERFLOW[cs.overflowY]) return node;
      node = composedParent(node);
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * 视觉顺序审计：采集 Tab 顺序节点的实际矩形（getBoundingClientRect，视口坐标）
   * 与最近滚动容器，运行纯函数 auditVisualOrder；同时输出滚动容器目录
   * （id / 类型 / 标签 / 分段选择器）供父页面展示与导出。
   * 文档方向取 <html> 的计算 direction（LTR/RTL）。
   */
  function computeVisualAudit() {
    var direction = 'ltr';
    try {
      if (getComputedStyle(document.documentElement).direction === 'rtl') direction = 'rtl';
    } catch (e) { /* 保持 ltr */ }

    var containers = [];          // [{ id, kind, label, selector }]
    var containerIds = new Map(); // 容器元素 → id
    function containerIdFor(el) {
      if (containerIds.has(el)) return containerIds.get(el);
      var isDoc = el === (document.scrollingElement || document.documentElement);
      var id = isDoc ? 'document' : 'c' + (containers.length + 1);
      containerIds.set(el, id);
      containers.push({
        id: id,
        kind: isDoc ? 'document' : 'element',
        label: isDoc ? '文档根滚动容器' : describe(el).css,
        selector: isDoc ? null : stableRoute(el)
      });
      return id;
    }

    var nodes = [];
    for (var i = 0; i < order.length; i++) {
      var e = entries[order[i]];
      // 不在文档中的元素得到全零矩形 → 由纯函数标为 zero-size
      var r = e.el.getBoundingClientRect();
      nodes.push({
        step: i + 1,
        selector: e.selector,
        label: e.label,
        rect: {
          left: Math.round(r.left * 100) / 100,
          top: Math.round(r.top * 100) / 100,
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100
        },
        container: containerIdFor(scrollContainerOf(e.el))
      });
    }
    var result = auditVisualOrder(nodes, { direction: direction });
    result.containers = containers;
    return result;
  }

  /* ---------------- 控件名称审计（DOM） ---------------- */

  /**
   * 名称文本沿「open Shadow DOM + slot 组合树」读取，规则：
   *  - 元素存在 open shadowRoot 时读取 shadow 子树，轻 DOM 只经由其中 <slot>
   *    分配的节点进入组合位置（未分配轻 DOM 被忽略）；
   *  - <slot> 有分配节点时读取分配节点（转发链递归展开），否则读取 fallback；
   *  - 普通内容（mode='normal'）跳过子树中 [hidden]、display:none、
   *    visibility:hidden/collapse 的节点（根节点自身的隐藏不做判断——
   *    是否可见性由调用方在树上下文中处理）；
   *  - mode='direct'：节点是被 ID 直接引用的目标（aria-labelledby / label[for]），
   *    取其整棵子树文字，即使该节点（或其后代）被隐藏也照样读取；
   *  - 引用目标不再追随 aria-labelledby / aria-label（不做名称递归）；
   *  - SCRIPT / STYLE / TEMPLATE / NOSCRIPT 内容永远不参与名称文本。
   */
  var NAME_NO_TEXT_TAGS = { SCRIPT: true, STYLE: true, TEMPLATE: true, NOSCRIPT: true };

  function nameTextNodeValue(node) {
    return node.nodeValue == null ? '' : String(node.nodeValue);
  }

  /** <slot> 分配节点扁平化（含转发链），文本节点与元素都计入 */
  function flattenAssignedNodes(slot, seen) {
    seen = seen || new Set();
    if (seen.has(slot)) return [];
    seen.add(slot);
    var out = [];
    var assigned = typeof slot.assignedNodes === 'function'
      ? slot.assignedNodes()
      : Array.prototype.slice.call(slot.childNodes);
    assigned.forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'SLOT') {
        out.push.apply(out, flattenAssignedNodes(n, seen));
      } else {
        out.push(n);
      }
    });
    return out;
  }

  /**
   * @param {Node} root 读取根
   * @param {'normal'|'direct'} mode normal 跳过隐藏子树；direct 整棵子树照读
   */
  function composedText(root, mode) {
    var direct = mode === 'direct';
    var parts = [];

    function pushElement(el) {
      if (!direct && isNameSubtreeHidden(el)) return;
      var sr = el.shadowRoot;
      if (sr) {
        // open shadow root：读 shadow 子树；轻 DOM 仅经其中 slot 分配进入
        childNodesOf(sr).forEach(walk);
        return;
      }
      if (el.tagName === 'SLOT') {
        var assigned = flattenAssignedNodes(el);
        if (assigned.length > 0) {
          assigned.forEach(walk);
        } else {
          childNodesOf(el).forEach(walk);
        }
        return;
      }
      childNodesOf(el).forEach(walk);
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) { // TEXT_NODE
        parts.push(nameTextNodeValue(node));
        return;
      }
      if (node.nodeType !== 1) return; // 元素节点
      if (NAME_NO_TEXT_TAGS[node.tagName]) return;
      pushElement(node);
    }

    if (root.nodeType === 3) return collapseWhitespace(nameTextNodeValue(root));
    if (root.nodeType !== 1) return '';
    pushElement(root);
    return collapseWhitespace(parts.join(''));
  }

  function childNodesOf(node) {
    return Array.prototype.slice.call(node.childNodes || []);
  }

  /** 元素是否因 [hidden] / display:none / visibility:hidden 而跳过其整棵子树文字 */
  function isNameSubtreeHidden(el) {
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    var cs = getComputedStyle(el);
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    return false;
  }

  /**
   * 树作用域内按 id 解析（不跨 shadow 边界）：
   * ID 引用 / label 关联仅在控件所属 Document/ShadowRoot 内解析。
   * @returns {{state:'ok'|'missing'|'duplicate', el:(Element|null)}}
   */
  function resolveIdInScope(id, root) {
    var found = root.querySelectorAll('#' + cssEscapeIdent(id));
    if (found.length === 0) return { state: 'missing', el: null };
    if (found.length > 1) return { state: 'duplicate', el: null };
    return { state: 'ok', el: found[0] };
  }

  /** aria-labelledby：多引用按声明顺序拼接；缺失 ID 诊断；命中重复 ID → 歧义 */
  function ariaLabelledbyCandidate(el) {
    var raw = el.getAttribute('aria-labelledby');
    if (raw === null) return null; // 属性缺省：不参与候选
    var root = el.getRootNode();
    var tokens = String(raw).split(/\s+/).filter(Boolean);
    var refs = [];
    var ambiguous = false;
    var pieces = [];
    tokens.forEach(function (id) {
      var hit = resolveIdInScope(id, root);
      refs.push({ attr: 'aria-labelledby', id: id, state: hit.state });
      if (hit.state === 'duplicate') {
        ambiguous = true;
      } else if (hit.state === 'ok') {
        // 引用目标取整棵子树文字，且不再追随 aria-labelledby / aria-label
        pieces.push(composedText(hit.el, 'direct'));
      }
      // missing：贡献空文本，诊断保留，后续来源仍可兜底
    });
    return {
      source: 'aria-labelledby',
      name: collapseWhitespace(pieces.join(' ')),
      ambiguous: ambiguous,
      refs: refs
    };
  }

  function ariaLabelCandidate(el) {
    if (!el.hasAttribute('aria-label')) return null;
    return {
      source: 'aria-label',
      name: collapseWhitespace(el.getAttribute('aria-label')),
      ambiguous: false,
      refs: []
    };
  }

  /**
   * 文本框原生 label（仅 input[type=text]）：
   *  - 控件 id 在所属树作用域内重复 → 无法判定（label[for] 指向不明）；
   *  - <label for=id>（同树作用域）+ 包裹型 <label>，按文档序合并；
   *  - label[for] 指向被隐藏节点时按「直接引用」取整棵子树文字。
   */
  function nativeLabelCandidate(el) {
    var root = el.getRootNode();
    var refs = [];
    var labels = [];

    if (el.id) {
      var idHit = resolveIdInScope(String(el.id), root);
      if (idHit.state === 'duplicate') {
        refs.push({ attr: 'label[for]', id: String(el.id), state: 'duplicate' });
        return { source: 'label', name: null, ambiguous: true, refs: refs };
      }
    }

    var forLabels = root.querySelectorAll ? root.querySelectorAll('label[for]') : [];
    Array.prototype.forEach.call(forLabels, function (lab) {
      if (el.id && lab.getAttribute('for') === String(el.id) && labels.indexOf(lab) < 0) {
        labels.push(lab);
      }
    });

    // 包裹型 label（祖先链，不跨 shadow 边界）
    var p = el.parentElement;
    while (p) {
      if (p.tagName === 'LABEL') {
        if (labels.indexOf(p) < 0) labels.push(p);
        break; // label 不可嵌套，取最近一层
      }
      p = p.parentElement;
    }

    // 按文档序（compareDocumentOrder）合并多个 label
    labels.sort(function (a, b) {
      var pos = a.compareDocumentPosition ? a.compareDocumentPosition(b) : 0;
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    var pieces = labels.map(function (lab) {
      // label 文本：直接引用的 label（含 for 关联）即便被隐藏也取整棵子树文字
      return composedText(lab, 'direct');
    });
    return {
      source: 'label',
      name: collapseWhitespace(pieces.join(' ')),
      ambiguous: false,
      refs: refs
    };
  }

  /** 按钮 / 链接的内容文本（普通内容：跳过隐藏子树） */
  function contentCandidate(el) {
    return {
      source: 'content',
      name: composedText(el, 'normal'),
      ambiguous: false,
      refs: []
    };
  }

  function titleCandidate(el) {
    if (!el.hasAttribute('title')) return null;
    return {
      source: 'title',
      name: collapseWhitespace(el.getAttribute('title')),
      ambiguous: false,
      refs: []
    };
  }

  /**
   * 控件名称审计：遍历候选节点（与焦点分析共享 entries，按组合树序），
   * 限 button / a[href] / input[type=text]；未分配轻 DOM、被抑制的 fallback
   * 子树不渲染，不参与审计；closed 根宿主轻 DOM 节点物理可达，照常审计
   * （其「渲染是否存在不可确定」由 closed 徽章另行表达）。
   */
  function computeNameAudit() {
    var items = [];
    var seen = new Set();
    entries.forEach(function (e) {
      var el = e.el;
      if (seen.has(el)) return;
      var hasHref = el.tagName === 'A' ? el.hasAttribute('href') : false;
      if (!isNameAuditTarget(el.tagName.toLowerCase(), el.type, hasHref)) return;
      seen.add(el);
      if (unassignedSet.has(el) || suppressedFallbackSet.has(el)) return;

      var candidates = [];
      var ll = ariaLabelledbyCandidate(el);
      if (ll) candidates.push(ll);
      var al = ariaLabelCandidate(el);
      if (al) candidates.push(al);
      if (el.tagName === 'INPUT') candidates.push(nativeLabelCandidate(el));
      if (el.tagName === 'BUTTON' || el.tagName === 'A') candidates.push(contentCandidate(el));
      var tt = titleCandidate(el);
      if (tt) candidates.push(tt);

      var picked = pickNameSource(candidates, el.tagName.toLowerCase());
      items.push({
        selector: e.selector,
        label: e.label,
        tag: e.tag,
        text: e.text,
        status: e.status,
        step: null, // 由调用方按 order 填充
        shadow: e.shadow,
        name: picked.name,
        nameSource: picked.source,
        nameState: picked.state,
        refs: picked.refs.map(function (r) {
          return { attr: r.attr, id: r.id, state: r.state };
        }),
        reasons: picked.reasons.map(function (r) {
          return { code: r.code, message: r.message };
        })
      });
    });

    // 填充 Tab 序号（仅在顺序中的控件）
    for (var i = 0; i < order.length; i++) {
      var sel = entries[order[i]].selector;
      for (var j = 0; j < items.length; j++) {
        if (items[j].selector === sel) items[j].step = i + 1;
      }
    }

    var missingCount = items.filter(function (x) { return x.nameState === 'missing'; }).length;
    var ambiguousCount = items.filter(function (x) { return x.nameState === 'ambiguous'; }).length;
    var missingIdCount = 0;
    var duplicateIdCount = 0;
    items.forEach(function (x) {
      x.refs.forEach(function (r) {
        if (r.state === 'missing') missingIdCount++;
        if (r.state === 'duplicate') duplicateIdCount++;
      });
    });
    return {
      items: items,
      diagnostics: buildNameAuditDiagnostics(items.map(function (x) {
        // 纯函数以 state / refs 描述审计结果，序列化条目使用 nameState
        return {
          state: x.nameState,
          label: x.label,
          selector: x.selector,
          refs: x.refs
        };
      })),
      stats: {
        controls: items.length,
        named: items.length - missingCount - ambiguousCount,
        missing: missingCount,
        ambiguous: ambiguousCount,
        missingIdRefs: missingIdCount,
        duplicateIdRefs: duplicateIdCount
      }
    };
  }

  function computeAndSend() {
    try {
      buildEntries();
      order = computeOrder(entries);
      var serialized = serializeEntries();
      for (var s = 0; s < order.length; s++) {
        serialized[order[s]].step = s + 1;
      }
      var diagnostics = buildDiagnostics(entries, order);
      var sd = shadowStats();
      buildShadowDiagnostics({
        openCount: sd.openRoots,
        closed: sd.closedRoots,
        unassignedCount: sd.unassignedCandidates,
        suppressedFallbackCount: sd.suppressedFallbackCandidates
      }).forEach(function (d2) { diagnostics.push(d2); });

      post({
        type: 'route',
        payload: {
          entries: serialized,
          order: order.map(function (idx) { return serialized[idx].selector; }),
          diagnostics: diagnostics,
          modalAudit: computeModalAudit(),
          visualAudit: computeVisualAudit(),
          nameAudit: computeNameAudit(),
          stats: {
            candidates: entries.length,
            ordered: order.length,
            excluded: entries.filter(function (e) { return e.status === 'excluded'; }).length,
            programmatic: entries.filter(function (e) { return e.status === 'programmatic'; }).length,
            shadow: sd
          }
        }
      });
    } catch (err) {
      post({ type: 'error', message: String(err && err.message || err) });
    }
  }

  /* ---------------- 高亮 ---------------- */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-focus-lab', 'overlay');
    overlay.style.cssText =
      'position:absolute;pointer-events:none;z-index:2147483647;display:none;' +
      'border:3px solid #ff2d78;border-radius:4px;' +
      'box-shadow:0 0 0 3px rgba(255,45,120,.25);transition:all .12s ease;';
    badge = document.createElement('div');
    badge.style.cssText =
      'position:absolute;top:-26px;left:-3px;background:#ff2d78;color:#fff;' +
      'font:12px/18px ui-monospace,monospace;padding:0 8px;border-radius:3px;white-space:nowrap;';
    overlay.appendChild(badge);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function highlightStep(step) {
    if (step < 0 || step >= order.length) return;
    var entry = entries[order[step]];
    var el = entry.el;
    if (!el || !el.isConnected) return;
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = 'solid';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    badge.textContent = 'Tab ' + (step + 1) + ' / ' + order.length;
    currentStep = step;
    post({ type: 'highlighted', step: step, selector: entry.selector, label: entry.label });
  }

  function clearHighlight() {
    if (overlay) overlay.style.display = 'none';
    currentStep = -1;
  }

  /**
   * 按分段选择器高亮任意候选节点（含被排除 / 仅编程聚焦 / shadow 内部节点，
   * 虚线框展示）。供父页面「基线对比」差异项与「模态审计」条目点击联动。
   * 目标不是候选节点时，回退为按分段选择器直接定位（closed 根内部必然失败）。
   */
  function highlightNodeBySelector(selector, opts) {
    opts = opts || {};
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].selector === selector) { entry = entries[i]; break; }
    }
    var el = entry && entry.el;
    if (!el || !el.isConnected) {
      el = resolveRoute(selector);
    }
    if (!el || !el.isConnected) {
      post({ type: 'highlight-miss', selector: selector });
      return;
    }
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = opts.solid ? 'solid' : 'dashed';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    if (opts.badge) {
      badge.textContent = opts.badge;
    } else if (entry) {
      var oi = order.indexOf(entries.indexOf(entry));
      if (oi >= 0) {
        badge.textContent = 'Tab ' + (oi + 1) + ' / ' + order.length;
      } else {
        var STATUS_BADGE = { excluded: '已排除', programmatic: '仅编程聚焦', 'not-focusable': '不可聚焦' };
        badge.textContent = STATUS_BADGE[entry.status] || entry.status;
      }
    } else {
      badge.textContent = '元素';
    }
    currentStep = -1;
    post({ type: 'highlighted', step: -1, selector: selector });
  }

  /* ---------------- 通信 ---------------- */

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.target !== SOURCE) return;
    if (d.type === 'highlight') {
      highlightStep(d.step);
    } else if (d.type === 'highlight-node') {
      highlightNodeBySelector(d.selector, { badge: d.badge, solid: d.solid });
    } else if (d.type === 'clear') {
      clearHighlight();
    } else if (d.type === 'recompute') {
      computeAndSend();
    }
  });

  // DOM 与样式就绪后执行首次计算
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(computeAndSend, 0); });
  } else {
    setTimeout(computeAndSend, 0);
  }
})();

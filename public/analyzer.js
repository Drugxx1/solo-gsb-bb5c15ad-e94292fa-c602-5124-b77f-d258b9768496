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
 *  6. 控件名称审计：对组合树内的 button / a[href] / input[type=text]
 *     计算可访问名称（aria-labelledby → aria-label → 原生 label（文本框）
 *     → 内容（按钮/链接）→ title，取首个非空结果，折叠空白）；id 引用与
 *     label 关联仅在控件所属 Document / ShadowRoot 内解析，文本沿 open
 *     Shadow DOM 与 slot 组合树读取；
 *  7. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics /
 * pickActiveModal / computeModalCycle / buildModalDiagnostics /
 * parseRoute / formatRoute / buildShadowDiagnostics / auditVisualOrder /
 * collapseWs / parseIdList / pickNameSource）
 * 不依赖 DOM，会在 Node 环境下导出，供单元测试使用。
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

  /* ---------------- 控件名称审计（纯函数部分） ---------------- */

  /** 折叠空白：连续空白（含换行 / 制表）压成单个空格，并去除首尾空白 */
  function collapseWs(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /** 解析 aria-labelledby 的 id 引用列表（空白分隔，保持声明顺序） */
  function parseIdList(raw) {
    var t = collapseWs(raw);
    return t ? t.split(' ') : [];
  }

  /**
   * 名称来源裁决：按优先级取首个非空文本的来源。
   * @param {Array<{source:string, text:string}>} sources 按优先级排列的候选（文本须已折叠空白）
   * @returns {{name:(string|null), source:(string|null)}}
   */
  function pickNameSource(sources) {
    var list = sources || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s && s.text) return { name: s.text, source: s.source };
    }
    return { name: null, source: null };
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
        collapseWs: collapseWs,
        parseIdList: parseIdList,
        pickNameSource: pickNameSource
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

  /* ---------------- 控件名称审计（DOM，组合树） ---------------- */

  // 审计范围：仅 button、a[href]、input[type=text]（CSS 选择器字面语义）
  var NAME_AUDIT_SELECTOR = 'button, a[href], input[type="text"]';
  var NAME_AUDIT_SCOPE = 'button, a[href], input[type=text]';

  // 名称来源展示标签（父页面渲染与缺名原因说明共用此顺序语义）
  var NAME_SOURCE_LABELS = {
    'aria-labelledby': 'aria-labelledby',
    'aria-label': 'aria-label',
    'label': '原生 label',
    'content': '内容',
    'title': 'title'
  };

  // 不贡献渲染文本的元素（样式 / 脚本 / 模板内容不是文本）
  var NAME_TEXT_SKIP_TAGS = { STYLE: true, SCRIPT: true, TEMPLATE: true, NOSCRIPT: true };

  /** 元素自身是否隐藏（hidden 属性 / display:none / visibility:hidden|collapse，不含祖先） */
  function selfHidden(el) {
    if (el.hasAttribute('hidden')) return true;
    var cs = getComputedStyle(el);
    if (cs.display === 'none') return true;
    return cs.visibility === 'hidden' || cs.visibility === 'collapse';
  }

  /** 节点是否处于隐藏子树中（沿组合祖先链：hidden 属性 / display:none / visibility） */
  function isHiddenNode(el) {
    if (composedClosest(el, '[hidden]')) return true;
    var node = el;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return true;
      var p = node.parentElement;
      if (!p) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) { node = rt.host; continue; }
        break;
      }
      node = p;
    }
    var cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || cs.visibility === 'collapse';
  }

  /** slot 的扁平化分配节点（含文本节点；转发链由 flatten 展开） */
  function assignedNodesFlattened(slot) {
    if (typeof slot.assignedNodes === 'function') {
      try {
        return Array.prototype.slice.call(slot.assignedNodes({ flatten: true }));
      } catch (err) { /* 回退到元素级展开 */ }
    }
    return flattenAssigned(slot);
  }

  /**
   * 沿组合树收集文本到 out（文本节点原始值依次压入，调用方拼接后折叠空白）：
   * 展开 open shadowRoot、按 slot 分配（含转发链）渲染轻 DOM、未分配 slot
   * 用 fallback；未分配的宿主轻 DOM 不进入遍历。
   * skipHidden 为 true 时跳过 hidden 属性 / display:none / visibility:hidden
   * 子树（普通内容规则）；为 false 时取整棵子树文字（aria-labelledby
   * 直接引用隐藏节点的规则）。isRoot 标记的节点自身不做隐藏跳过
   * （其隐藏与否由调用方在选定 skipHidden 时判定）。
   */
  function collectNodeText(node, skipHidden, out, isRoot) {
    if (node.nodeType === 3) { // 文本节点
      out.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return; // 注释等不贡献文本
    var el = node;
    if (el.hasAttribute('data-focus-lab')) return; // 实验室自身的高亮覆盖层
    if (NAME_TEXT_SKIP_TAGS[el.tagName]) return;
    if (!isRoot && skipHidden && selfHidden(el)) return;
    var sr = el.shadowRoot;
    if (sr) {
      // 组合树：宿主位置渲染的是 shadow 树；轻 DOM 仅经 slot 分配进入
      var sc = sr.childNodes;
      for (var i = 0; i < sc.length; i++) collectNodeText(sc[i], skipHidden, out, false);
      return;
    }
    if (el.tagName === 'SLOT') {
      var assigned = assignedNodesFlattened(el);
      var list = assigned.length > 0 ? assigned : el.childNodes;
      for (var j = 0; j < list.length; j++) collectNodeText(list[j], skipHidden, out, false);
      return;
    }
    var kids = el.childNodes;
    for (var k = 0; k < kids.length; k++) collectNodeText(kids[k], skipHidden, out, false);
  }

  /**
   * 元素的组合树文本（折叠空白后）。skipHidden 语义同 collectNodeText；
   * 元素自身不作为「隐藏子树」跳过（隐藏判定沿其子树进行）。
   */
  function composedText(el, skipHidden) {
    var out = [];
    collectNodeText(el, skipHidden, out, true);
    return collapseWs(out.join(''));
  }

  // 每次名称审计重建：根（Document / ShadowRoot）→ id → 匹配元素数组
  var nameAuditIdCache = null;

  /** 在控件所属根内按 id 解析（不跨 Document / ShadowRoot 边界）；返回全部匹配 */
  function findByIdInRoot(root, id) {
    var map = nameAuditIdCache.get(root);
    if (!map) { map = new Map(); nameAuditIdCache.set(root, map); }
    if (map.has(id)) return map.get(id);
    var out = [];
    var all = root.querySelectorAll('[id]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) out.push(all[i]);
    }
    map.set(id, out);
    return out;
  }

  /**
   * 原生 <label> 关联文本（仅 input[type=text] 使用）：
   * 同根内 label[for=控件id]（按树序拼接）+ 包裹控件的祖先 label；
   * 关联仅在控件所属 Document / ShadowRoot 内解析。
   */
  function nativeLabelText(el, root) {
    var texts = [];
    var seen = [];
    if (el.id) {
      var labels = root.querySelectorAll('label[for]');
      for (var i = 0; i < labels.length; i++) {
        var lb = labels[i];
        // label.control 由浏览器按 id 在 label 所属树内解析（重复 id 归首个匹配）；
        // 环境不支持时回退为 for 属性与控件 id 的字面比较
        var mine = (typeof lb.control !== 'undefined') ? lb.control === el : lb.htmlFor === el.id;
        if (mine && seen.indexOf(lb) < 0) {
          seen.push(lb);
          texts.push(composedText(lb, true));
        }
      }
    }
    // 包裹关联：祖先 <label>（物理父链天然不跨根）；label 的 for 指向他处时不算
    var wrapping = el.closest ? el.closest('label') : null;
    if (wrapping && seen.indexOf(wrapping) < 0) {
      var wrapMine = (typeof wrapping.control !== 'undefined')
        ? wrapping.control === el
        : (!wrapping.htmlFor || wrapping.htmlFor === el.id);
      if (wrapMine) texts.push(composedText(wrapping, true));
    }
    return collapseWs(texts.join(' '));
  }

  /**
   * 计算单个控件的可访问名称：
   * 优先级 aria-labelledby → aria-label → 原生 label（文本框）→ 内容（按钮/链接）
   * → title，取首个非空结果（折叠空白）。
   *  - aria-labelledby 的 id 引用仅在控件所属 Document / ShadowRoot 内解析，
   *    多引用按声明顺序拼接；缺失 id 记诊断；引用重复 id 时无法判定；
   *  - 引用目标不再追随其自身的 aria-labelledby，直接读取文本；
   *    直接引用的隐藏节点取整棵子树文字，否则按普通规则跳过隐藏子树；
   *  - 文本沿 open Shadow DOM 与 slot 组合树读取，忽略未分配轻 DOM。
   */
  function auditControlName(el, entry) {
    var root = el.getRootNode();
    var rootKind = (root instanceof ShadowRoot) ? 'ShadowRoot' : 'Document';
    var diagnostics = [];

    // 1) aria-labelledby：多引用按声明顺序拼接
    var labelledbyText = '';
    var duplicate = null;
    if (el.hasAttribute('aria-labelledby')) {
      var ids = parseIdList(el.getAttribute('aria-labelledby'));
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        var matches = findByIdInRoot(root, ids[i]);
        if (matches.length === 0) {
          diagnostics.push({
            code: 'missing-reference',
            message: 'aria-labelledby 引用的 id "' + ids[i] + '" 在所属 ' + rootKind + ' 内不存在'
          });
        } else if (matches.length > 1) {
          duplicate = { id: ids[i], count: matches.length };
          break;
        } else {
          var ref = matches[0];
          // 引用目标不再追随其 aria-labelledby；直接引用的隐藏节点取整棵子树文字
          parts.push(composedText(ref, !isHiddenNode(ref)));
        }
      }
      if (!duplicate) labelledbyText = collapseWs(parts.join(' '));
    }

    var item = {
      selector: entry.selector,
      label: entry.label,
      tag: el.tagName.toLowerCase(),
      step: null, // 由 computeNameAudit 填充（1 基 Tab 序号，不在顺序中时为 null）
      focusStatus: entry.status,
      name: null,
      source: null,
      status: 'named',
      reason: null,
      message: '',
      diagnostics: diagnostics,
      shadow: entry.shadow
    };

    // 引用重复 id：无法判定（不臆测名称，也不再回退其他来源）
    if (duplicate) {
      item.status = 'undetermined';
      item.reason = 'duplicate-reference';
      item.message = 'aria-labelledby 引用的 id "' + duplicate.id + '" 在所属 ' + rootKind +
        ' 内有 ' + duplicate.count + ' 个匹配，引用目标无法判定';
      return item;
    }

    // 2) 按优先级取首个非空来源
    var sources = [
      { source: 'aria-labelledby', text: labelledbyText },
      { source: 'aria-label', text: collapseWs(el.getAttribute('aria-label')) }
    ];
    if (el.tagName === 'INPUT') {
      sources.push({ source: 'label', text: nativeLabelText(el, root) });
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
      sources.push({ source: 'content', text: composedText(el, true) });
    }
    sources.push({ source: 'title', text: collapseWs(el.getAttribute('title')) });

    var picked = pickNameSource(sources);
    if (!picked.name) {
      item.status = 'missing';
      item.reason = 'no-accessible-name';
      item.message = '缺少可访问名称：' + sources.map(function (s) {
        return NAME_SOURCE_LABELS[s.source];
      }).join('、') + ' 均为空';
      return item;
    }
    item.name = picked.name;
    item.source = picked.source;
    return item;
  }

  /**
   * 控件名称审计：对组合树内的 button / a[href] / input[type=text] 逐一计算
   * 可访问名称（未分配轻 DOM、被抑制的 fallback、closed 不可确定子树不参与）。
   */
  function computeNameAudit() {
    nameAuditIdCache = new WeakMap();
    var indexByEl = new Map();
    for (var i = 0; i < entries.length; i++) indexByEl.set(entries[i].el, i);
    var stepOf = new Map();
    for (var s = 0; s < order.length; s++) stepOf.set(order[s], s + 1);

    var items = [];
    for (var j = 0; j < allElements.length; j++) {
      var el = allElements[j];
      if (!el.matches || !el.matches(NAME_AUDIT_SELECTOR)) continue;
      // 未分配 / fallback 抑制 / closed 不可确定的子树不在组合树渲染范围内
      if (unassignedSet.has(el) || undeterminedSet.has(el) || suppressedFallbackSet.has(el)) continue;
      var idx = indexByEl.get(el);
      if (idx === undefined) continue; // 理论上三类控件均为候选节点
      var item = auditControlName(el, entries[idx]);
      item.step = stepOf.has(idx) ? stepOf.get(idx) : null;
      items.push(item);
    }
    var stats = { total: items.length, named: 0, missing: 0, undetermined: 0 };
    items.forEach(function (it) { stats[it.status]++; });
    return { scope: NAME_AUDIT_SCOPE, items: items, stats: stats };
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

/**
 * dsh-flowmeter —— 模型输出「流速」仪表（Client 半）。
 *
 * 接替输入框下方统计行（`conversation.composer.dock`）里官方那枚「输出速度」格子，
 * 显示：实时速度 tok/s · 最近十秒柱状图 · 首字延迟。因为占的是 `activity` 这一格，
 * 读数排在整行最前面，官方那枚整步平均速度也就不再重复显示。
 *
 * 数据来自 Host 半注册的只读端点 `/dsh-flowmeter/state.json`（同源轮询）。
 * 相位自适应：等首字/出字时 500ms 一次，其余 2.5s 一次；页面不可见时退到慢速。
 * 只做渲染，不监听 DOM、不写 body、不改别人的条目。
 */
window.__ModuleLoader__.load({
  id: 'dsh-flowmeter',
  factory(require) {
    const React = require('react');
    const { useEffect, useState } = React;
    const h = React.createElement;

    /** 本插件的 locale 命名空间。 */
    const NS = 'composer.flowmeter';
    /** Host 半暴露的只读读数端点。 */
    const ENDPOINT = '/dsh-flowmeter/state.json';
    /** 全库读数端点：侧栏底部那枚。 */
    const SUMMARY_ENDPOINT = '/dsh-flowmeter/summary.json';
    /** 画多少根柱子：24 × 400ms ≈ 9.6 秒。 */
    const BAR_COUNT = 24;
    /** 柱状图高度（像素）。 */
    const BAR_HEIGHT = 14;
    /** Host 每个分桶的宽度（毫秒），侧栏时窗按它换算成桶数。 */
    const TREND_BUCKET_MS = 400;
    /** 侧栏曲线可选的时间跨度（秒）：默认 20 秒，约为输入框那枚的 2 倍。 */
    const TREND_SPANS = [10, 20, 40];
    const TREND_SPAN_DEFAULT = 20;
    /** 忙碌/空闲的轮询间隔。 */
    const FAST_POLL_MS = 500;
    const SLOW_POLL_MS = 2500;

    const zh = {
      live: '实时',
      unit: 'tok/s',
      ttft: '首字',
      avg: '均速',
      stepTokens: '本步 {count} tok',
      wallBasis: '整步计速',
      totalTag: '合计',
      modeSum: '累加',
      modeAvg: '平均',
      modeGroup: '统计口径',
      activeSessions: '{count} 个会话',
      settingsTotal: '侧栏口径',
      settingsTotalHint: '侧栏读数取所有会话相加，还是按会话取平均',
      settingsSpan: '侧栏时窗',
      settingsSpanHint: '侧栏曲线显示最近多少秒；默认 20 秒',
      settingsColour: '配色',
      settingsColourHint: '数字、图表与标签统一用这个颜色',
      settingsChart: '图表',
      settingsChartHint: '两者用同一组 400ms 分桶，只是画法不同',
      optionDefault: '默认',
      optionBlue: '蓝',
      optionTeal: '青',
      optionPurple: '紫',
      optionAmber: '橙',
      optionGreen: '绿',
      optionGrey: '灰',
      optionCustom: '自定义',
      chartBars: '柱状图',
      chartCurve: '曲线图',
    };
    const en = {
      live: 'Live',
      unit: 'tok/s',
      ttft: 'TTFT',
      avg: 'Avg',
      stepTokens: 'This step {count} tok',
      wallBasis: 'whole-step timing',
      totalTag: 'Total',
      modeSum: 'Sum',
      modeAvg: 'Avg',
      modeGroup: 'Aggregation',
      activeSessions: '{count} sessions',
      settingsTotal: 'Sidebar total',
      settingsTotalHint: 'Whether the sidebar meter adds every session together or averages per session',
      settingsSpan: 'Sidebar span',
      settingsSpanHint: 'How many seconds the sidebar curve shows; 20 seconds by default',
      settingsColour: 'Colour',
      settingsColourHint: 'One colour for the numbers, chart and labels',
      settingsChart: 'Chart',
      settingsChartHint: 'Both use the same 400ms buckets; only the drawing differs',
      optionDefault: 'Default',
      optionBlue: 'Blue',
      optionTeal: 'Teal',
      optionPurple: 'Purple',
      optionAmber: 'Amber',
      optionGreen: 'Green',
      optionGrey: 'Grey',
      optionCustom: 'Custom',
      chartBars: 'Bars',
      chartCurve: 'Curve',
    };

    /** 配色预设：空字符串 = 跟随主题（品牌色）。 */
    const COLOUR_PRESETS = [
      { value: '', label: 'optionDefault' },
      { value: '#3d6df6', label: 'optionBlue' },
      { value: '#0ea5a4', label: 'optionTeal' },
      { value: '#7c5cf0', label: 'optionPurple' },
      { value: '#e0761f', label: 'optionAmber' },
      { value: '#1f9d55', label: 'optionGreen' },
      { value: '#6b7280', label: 'optionGrey' },
    ];
    /** 图表画法。 */
    const CHART_KINDS = ['bars', 'curve'];
    /** 侧栏合计口径：所有会话相加，或按会话取平均。 */
    const TOTAL_MODES = ['sum', 'avg'];
    /** 显示偏好存本地：纯展示项，不写 profile、不重启插件。 */
    const SETTINGS_KEY = 'dsh-flowmeter:settings';

    let settings = readSettings();
    const settingsListeners = new Set();

    /** 读回本地偏好，任何异常都退回默认值。 */
    function readSettings() {
      const fallback = { color: '', chart: 'bars', total: 'sum', span: TREND_SPAN_DEFAULT };
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (typeof raw !== 'string' || raw.length === 0) return fallback;
        const parsed = JSON.parse(raw);
        return {
          color: typeof parsed?.color === 'string' ? parsed.color : '',
          chart: CHART_KINDS.includes(parsed?.chart) ? parsed.chart : 'bars',
          total: TOTAL_MODES.includes(parsed?.total) ? parsed.total : 'sum',
          span: TREND_SPANS.includes(Number(parsed?.span)) ? Number(parsed.span) : TREND_SPAN_DEFAULT,
        };
      } catch (err) {
        return fallback;
      }
    }

    /** 写入一项偏好：先广播（读数与设置面板同时刷新），再落本地。 */
    function writeSettings(patch) {
      settings = { ...settings, ...patch };
      for (const listener of settingsListeners) {
        try {
          listener();
        } catch (err) {}
      }
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch (err) {}
    }

    /** 订阅显示偏好：任一窗口改动都会让两个组件一起重画。 */
    function useSettings() {
      const [, bump] = useState(0);
      useEffect(() => {
        const listener = () => bump((value) => value + 1);
        settingsListeners.add(listener);
        return () => {
          settingsListeners.delete(listener);
        };
      }, []);
      return settings;
    }

    // 整枚读数统一走品牌蓝（`--dsw-alias-brand-primary`）：标签、数字、单位、柱状图、
    // 分隔符都用 currentColor 继承同一个蓝，深浅只靠透明度分层，明暗主题自动跟随。
    // 间距、字号、圆角仍与宿主统计控件（StatsPills）一致。
    const CSS = [
      '.dshfm-anchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dshfm-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm,6px);max-width:100%;color:var(--dsw-alias-brand-primary,#3d6df6);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshfm-chart{align-items:flex-end;gap:1px;height:' + BAR_HEIGHT + 'px;width:60px;display:inline-flex}',
      '.dshfm-bar{flex:1 1 0;min-width:1px;border-radius:1px;background:currentColor;transition:height .18s ease-out,opacity .18s linear}',
      '.dshfm-curve{display:block;width:100%;height:100%}',
      '.dshfm-tag{margin-right:4px;opacity:.8}',
      '.dshfm-num{color:inherit;font-weight:600}',
      '.dshfm-unit{margin-left:3px;opacity:.8}',
      '.dshfm-sep{opacity:.35;margin:0 1px}',
      '.dshfm-rest{opacity:.7}',
      // 侧栏底部那张卡：两行 —— 第一行读数 + 口径切换，第二行整宽图表。
      // 席位行（sidebar.footer.action）是 flex；卡片自己占满一行。
      // `order` 比 OpenCode Go 额度卡（-100）更小，于是排在它上面一行。
      // slot 锚点是 display:contents，卡片因此是席位行的直接子项，:has 选择器才匹配得到。
      ':has(> [data-slot="sidebar.footer.action"] > .dshfm-quota){flex-wrap:wrap}',
      '.dshfm-quota{box-sizing:border-box;flex:0 0 100%;width:100%;min-width:0;order:-200;margin:2px 0 6px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.3;display:flex;flex-direction:column;gap:5px;user-select:none}',
      '.dshfm-quota-head{display:flex;align-items:center;gap:5px;min-width:0}',
      '.dshfm-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.5}',
      '.dshfm-dot-live{background:var(--dshfm-accent,var(--dsw-alias-brand-primary,#3d6df6));opacity:1}',
      '.dshfm-quota-label{flex:0 0 auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshfm-quota-value{flex:0 0 auto;color:var(--dshfm-accent,var(--dsw-alias-brand-primary,#3d6df6));font-size:13px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dshfm-quota-unit{flex:0 0 auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshfm-quota-sep{flex:0 0 auto;opacity:.35}',
      // 活跃会话数：宽度不够时先在这里省略，口径切换保持可见。
      '.dshfm-quota-sessions{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums}',
      '.dshfm-quota-seg{display:inline-flex;flex:0 0 auto;gap:1px;margin-left:auto;padding:1px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px}',
      '.dshfm-quota-segbtn{appearance:none;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:15px;padding:0 5px;cursor:pointer}',
      '.dshfm-quota-segbtn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      // currentColor 让曲线/面积统一走卡片强调色。
      '.dshfm-quota-chart{width:100%;min-width:0;color:var(--dshfm-accent,var(--dsw-alias-brand-primary,#3d6df6))}',
      '.dshfm-trend{display:flex;align-items:stretch;gap:5px;width:100%;height:36px;min-width:0}',
      '.dshfm-trend-axis{position:relative;flex:0 0 auto;width:20px;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:9px;font-variant-numeric:tabular-nums}',
      '.dshfm-trend-axis>span{position:absolute;right:0;transform:translateY(-50%);white-space:nowrap}',
      '.dshfm-trend-axis>span:nth-child(1){top:.5px}',
      '.dshfm-trend-axis>span:nth-child(2){top:50%}',
      '.dshfm-trend-axis>span:nth-child(3){top:calc(100% - .5px)}',
      '.dshfm-trend-plot{position:relative;flex:1 1 auto;min-width:0}',
      '.dshfm-trend-svg{display:block;width:100%;height:100%;overflow:visible}',
      '.dshfm-trend-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}',
      '.dshfm-trend-area{fill:currentColor;opacity:.12;stroke:none}',
      '.dshfm-trend-line{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}',
      // 折叠成 56px 窄栏时只剩一个 36px 的圆：放不下卡片，但读数还在。
      '.dshfm-rail{box-sizing:border-box;flex:none;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-brand-primary,#3d6df6);font:inherit;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}',
      '.dshfm-rail:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshfm-rail-num{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums}',
      '@media (prefers-reduced-motion: reduce){.dshfm-bar{transition:none}}',
      '.dshfmf-root{display:flex;flex-direction:column}',
      '.dshfmf-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0}',
      '.dshfmf-row+.dshfmf-row{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dshfmf-text{min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshfmf-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshfmf-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshfmf-controls{display:inline-flex;align-items:center;gap:10px;flex:none}',
      '.dshfmf-swatch{box-sizing:border-box;width:16px;height:16px;padding:0;border:0;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}',
      '.dshfmf-swatch:hover{outline:2px solid var(--dsw-alias-border-l2);outline-offset:2px}',
      '.dshfmf-swatch[aria-pressed="true"]{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}',
      '.dshfmf-custom{width:20px;height:20px;padding:0;border:0;background:transparent;cursor:pointer}',
      '.dshfmf-custom::-webkit-color-swatch-wrapper{padding:0}',
      '.dshfmf-custom::-webkit-color-swatch{border:.5px solid var(--dsw-alias-border-l2);border-radius:50%}',
      '.dshfmf-seg{display:inline-flex;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.dshfmf-segbtn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:2px 10px;border-radius:4px;cursor:pointer}',
      '.dshfmf-segbtn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
    ].join('');

    /** 有没有东西正在解码：决定轮询快慢。`busy` 是侧栏合计端点的字段。 */
    function isBusyState(data) {
      if (data === null || typeof data !== 'object') return false;
      if (data.busy === true) return true;
      return data.phase === 'waiting' || data.phase === 'streaming';
    }

    /**
     * 轮询一个只读端点。忙碌时快、空闲时慢，页面不可见时退到慢速；失败保留上一帧，不闪。
     * @param {string} url - 同源端点（可带查询串）。
     * @returns {object|null} 最近一次读数。
     */
    function usePolling(url) {
      const [state, setState] = useState(null);
      useEffect(() => {
        let alive = true;
        let timer = 0;
        const schedule = (delay) => {
          if (!alive) return;
          timer = setTimeout(tick, delay);
        };
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule(SLOW_POLL_MS);
            return;
          }
          fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (!alive) return;
              if (data !== null && typeof data === 'object') setState(data);
              schedule(isBusyState(data) ? FAST_POLL_MS : SLOW_POLL_MS);
            })
            .catch(() => {
              schedule(SLOW_POLL_MS);
            });
        };
        tick();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [url]);
      return state;
    }

    /**
     * 当前会话的读数（输入框脚下那枚）。
     * @param {string|undefined} sessionId - 当前会话 id。
     * @returns {object|null} 最近一次读数。
     */
    function useLiveState(sessionId) {
      const query = sessionId === undefined || sessionId === null
        ? ''
        : '?session=' + encodeURIComponent(String(sessionId));
      return usePolling(ENDPOINT + query);
    }

    /** 全库读数（侧栏底部那枚）。 */
    function useSummary() {
      return usePolling(SUMMARY_ENDPOINT);
    }

    /** 速度读数的显示精度：个位数留一位小数，两位数以上取整。 */
    function formatTps(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0.05) return '0';
      if (number < 10) return number.toFixed(1);
      return String(Math.round(number));
    }

    /** 秒数：短于 10 秒留两位小数，之后一位。 */
    function formatSeconds(ms) {
      const seconds = Math.max(0, Number(ms) || 0) / 1000;
      return (seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)) + 's';
    }

    /** Y 轴刻度文字：整数，超过四位数缩成 k，个位数留一位小数。 */
    function formatAxis(value) {
      const number = Math.max(0, Number(value) || 0);
      if (number >= 10000) return Math.round(number / 1000) + 'k';
      if (number >= 1000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (number >= 10) return String(Math.round(number));
      if (number === 0) return '0';
      return number.toFixed(1).replace(/\.0$/, '');
    }

    /** 轴顶取整到一位有效数字（286 → 300，143 → 200），曲线总能顶到接近画布上沿。 */
    function niceMax(value) {
      const number = Math.max(1, Number(value) || 0);
      const power = Math.pow(10, Math.floor(Math.log10(number)));
      return Math.ceil(number / power) * power;
    }

    /**
     * 把一串点连成平滑曲线：Catmull-Rom 转三次贝塞尔，控制点夹在画布内，避免过冲出界。
     * @param {{ x: number, y: number }[]} points - 从左到右的点。
     * @param {number} height - 画布高度（用于夹紧控制点）。
     * @returns {string} SVG 路径。
     */
    function smoothPath(points, height) {
      if (points.length === 0) return '';
      if (points.length === 1) return 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
      const clampY = (value) => Math.max(0, Math.min(height, value));
      let d = 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
      for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[index - 1] ?? points[index];
        const p1 = points[index];
        const p2 = points[index + 1];
        const p3 = points[index + 2] ?? p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
        d += 'C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' '
          + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ' '
          + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
      }
      return d;
    }

    /**
     * 曲线图：同一组分桶连成折线，下面垫一层同色面积，越新越靠右。
     * @param {{ values: number[], peak: number, width?: number, height?: number }} props
     *   桶速度、归一化峰值，以及可选的画布尺寸（侧栏卡片比输入框那枚宽）。
     */
    function SpeedCurve({ values, peak, width = 60, height = BAR_HEIGHT }) {
      const count = values.length;
      if (count === 0) return null;
      const inner = height - 1.5;
      const step = count > 1 ? width / (count - 1) : width;
      let line = '';
      values.forEach((value, index) => {
        const ratio = Math.max(0, Math.min(1, Number(value) / peak));
        const x = (index * step).toFixed(2);
        const y = (height - 0.75 - ratio * inner).toFixed(2);
        line += (index === 0 ? 'M' : 'L') + x + ' ' + y;
      });
      return h(
        'svg',
        {
          className: 'dshfm-curve',
          viewBox: '0 0 ' + width + ' ' + height,
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d: line + 'L' + width + ' ' + height + 'L0 ' + height + 'Z', fill: 'currentColor', opacity: 0.16, stroke: 'none' }),
        h('path', {
          d: line,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * 读数里的小图：柱状图或曲线图，数据、分桶、归一化完全一致，只有画法不同。
     * 不传尺寸时按输入框脚下那枚的 60×14 画；侧栏卡片传更宽更高的尺寸。
     * @param {{ values: number[], peak: number, kind: string, width?: number, height?: number }} props
     *   桶速度、归一化峰值、画法，以及可选的画布尺寸。
     */
    function SpeedChart({ values, peak, kind, width = 60, height = BAR_HEIGHT }) {
      if (kind === 'curve') {
        return h(
          'span',
          { className: 'dshfm-chart', 'aria-hidden': true },
          h(SpeedCurve, { values, peak, width, height }),
        );
      }
      const count = values.length;
      return h(
        'span',
        { className: 'dshfm-chart', 'aria-hidden': true },
        values.map((value, index) => {
          const ratio = Math.max(0, Math.min(1, Number(value) / peak));
          return h('span', {
            key: index,
            className: 'dshfm-bar',
            style: {
              height: Math.max(1.5, ratio * height).toFixed(1) + 'px',
              opacity: (0.25 + (0.6 * (index + 1)) / count).toFixed(2),
            },
          });
        }),
      );
    }

    /**
     * 侧栏合计卡的图：平滑曲线 + 简单 Y 轴（顶 / 中 / 底三档刻度，配三条水平网格线）。
     *
     * 用整宽 SVG 按视口拉伸（preserveAspectRatio="none"），横向正好铺满 24 个桶；
     * 线宽用 non-scaling-stroke 保持 1.4px，不会被拉细或拉粗。
     *
     * @param {{ values: number[], peak: number }} props - 桶速度与归一化峰值。
     */
    function SidebarTrend({ values, peak }) {
      const count = values.length;
      const width = 240;
      const height = 36;
      const top = niceMax(peak);
      const points = values.map((value, index) => {
        const ratio = Math.max(0, Math.min(1, Number(value) / top));
        return {
          x: count > 1 ? (index * width) / (count - 1) : width / 2,
          y: height - 0.75 - ratio * (height - 1.5),
        };
      });
      const line = smoothPath(points, height);
      const area = line === '' ? '' : line + 'L' + width + ' ' + height + 'L0 ' + height + 'Z';
      const ticks = [top, top / 2, 0];
      return h(
        'div',
        { className: 'dshfm-trend' },
        h(
          'div',
          { className: 'dshfm-trend-axis', 'aria-hidden': true },
          ticks.map((tick, index) => h('span', { key: index }, formatAxis(tick))),
        ),
        h(
          'div',
          { className: 'dshfm-trend-plot' },
          h(
            'svg',
            {
              className: 'dshfm-trend-svg',
              viewBox: '0 0 ' + width + ' ' + height,
              preserveAspectRatio: 'none',
              'aria-hidden': true,
              focusable: 'false',
            },
            ticks.map((tick, index) => h('line', {
              key: 'grid-' + index,
              x1: 0,
              x2: width,
              y1: index === 0 ? 0.5 : index === 1 ? height / 2 : height - 0.5,
              y2: index === 0 ? 0.5 : index === 1 ? height / 2 : height - 0.5,
              className: 'dshfm-trend-grid',
            })),
            area === '' ? null : h('path', { d: area, className: 'dshfm-trend-area' }),
            line === '' ? null : h('path', { d: line, className: 'dshfm-trend-line' }),
          ),
        ),
      );
    }

    /** slot 没绑定成字典时退回英文原文，别让读数因为缺一个 t 整块空掉。 */
    function translator(t) {
      if (typeof t === 'function') return t;
      return (key, params) =>
        String(en[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) =>
          params !== undefined && params[name] !== undefined ? String(params[name]) : whole,
        );
    }

    /**
     * 输入框下方的一枚读数：图表 + 实时速度 + 首字延迟 + 均速。
     * 配色与图表画法来自插件设置面板（存本地），改完立刻生效。
     * @param {{ sessionId?: string, t?: Function }} props - slot 注入的属性。
     */
    function FlowmeterPill({ sessionId, t: translate }) {
      const t = translator(translate);
      const display = useSettings();
      const state = useLiveState(sessionId);
      if (state === null) return null;

      const phase = typeof state.phase === 'string' ? state.phase : 'idle';
      const busy = phase === 'waiting' || phase === 'streaming';
      const last = state.last !== null && typeof state.last === 'object' ? state.last : null;
      const bars = Array.isArray(state.bars) ? state.bars.slice(-BAR_COUNT) : [];
      const liveTps = Number(state.tps) || 0;
      const hasBars = bars.some((value) => Number(value) > 0);

      // 既没在解码、也没有可回看的上一步读数：不占位。
      if (!busy && last === null && !hasBars) return null;

      const tps = liveTps;
      const ttftMs = busy
        ? state.ttftMs
        : last !== null && Number.isFinite(last.ttftMs)
          ? last.ttftMs
          : state.ttftMs;
      const waitingMs = phase === 'waiting' && Number.isFinite(state.waitingMs) ? state.waitingMs : null;
      // 本步均速：生成期间是这一步的滚动均速，落盘后是该步的精确值，等首字/空闲时沿用
      // 最近一步 —— 只要有过一步就一直显示，不会生成一停就消失。
      const avgTps = Number.isFinite(state.avgTps) && state.avgTps > 0 ? state.avgTps : null;
      const peak = Math.max(1, tps, ...bars.map((value) => Number(value) || 0));

      const reading = waitingMs !== null
        ? t('ttft') + ' ' + formatSeconds(waitingMs) + '…'
        : ttftMs !== null && Number.isFinite(ttftMs) && ttftMs > 0
          ? t('ttft') + ' ' + formatSeconds(ttftMs)
          : null;

      const detail = [];
      detail.push(t('live') + ' ' + formatTps(tps) + ' ' + t('unit'));
      if (busy && state.step !== null && typeof state.step === 'object') {
        detail.push(t('stepTokens', { count: state.step.tokens }));
      }
      if (last !== null && last.basis === 'wall') detail.push(t('wallBasis'));
      if (reading !== null) detail.push(reading);
      if (avgTps !== null) detail.push(t('avg') + ' ' + formatTps(avgTps) + ' ' + t('unit'));
      const title = detail.join(' · ');

      // 主读数之后依次追加：首字（或等待秒数）、均速。
      const trailing = [];
      if (reading !== null) trailing.push(reading);
      if (avgTps !== null) trailing.push(t('avg') + ' ' + formatTps(avgTps) + ' ' + t('unit'));

      return h(
        'span',
        { className: 'dshfm-anchor', 'data-composer-stat': 'dsh-flowmeter' },
        h(
          'span',
          {
            className: busy ? 'dshfm-pill' : 'dshfm-pill dshfm-rest',
            title,
            'aria-label': title,
            // 设置面板选了颜色就整体染色；留空则跟随主题的品牌色。
            style: display.color ? { color: display.color } : undefined,
          },
          // 先图后数：图表打头，实时速度跟在它后面，其余读数依次以「·」相接。
          h(SpeedChart, { values: bars, peak, kind: display.chart }),
          h(
            'span',
            { 'aria-hidden': true },
            h('span', { className: 'dshfm-tag' }, t('live')),
            h('span', { className: 'dshfm-num' }, formatTps(tps)),
            h('span', { className: 'dshfm-unit' }, t('unit')),
          ),
          trailing.map((text, index) =>
            h(
              React.Fragment,
              { key: index },
              h('span', { className: 'dshfm-sep', 'aria-hidden': true }, '·'),
              h('span', { 'aria-hidden': true }, text),
            ),
          ),
        ),
      );
    }

    /**
     * 侧栏底部的全库读数：所有会话的合计（或平均）速度 + 同一套分桶图表。
     *
     * 宽栏是一张两行的卡：第一行读数与「累加 / 平均」切换，第二行整宽平滑曲线（带简单 Y 轴）；
     * 折叠成 56px 窄栏时只剩一个 36px 的圆，显示数字，点一下切换口径。
     * 卡片 `order` 比 OpenCode Go 那张额度卡更小，因此排在它上面一行。
     *
     * @param {{ wide?: boolean, t?: Function }} props - 侧栏注入的栏宽与翻译函数。
     */
    function SidebarMeter({ wide, t: translate }) {
      const t = translator(translate);
      const display = useSettings();
      const summary = useSummary();
      if (summary === null) return null;

      const mode = display.total === 'avg' ? 'avg' : 'sum';
      const rawBars = mode === 'avg' ? summary.barsAvg : summary.barsSum;
      // 时窗按 400ms 一桶换算：20 秒 → 50 桶（Host 保留 120 桶历史）。
      const span = TREND_SPANS.includes(display.span) ? display.span : TREND_SPAN_DEFAULT;
      const bucketCount = Math.round((span * 1000) / TREND_BUCKET_MS);
      const bars = Array.isArray(rawBars) ? rawBars.slice(-bucketCount) : [];
      const tps = Math.max(0, Number(mode === 'avg' ? summary.avgTps : summary.sumTps) || 0);
      const peak = Math.max(1, tps, ...bars.map((value) => Number(value) || 0));
      const busy = summary.busy === true;
      const active = Number(summary.active) || 0;
      const modeLabel = t(mode === 'avg' ? 'modeAvg' : 'modeSum');
      const title = [
        t('totalTag') + ' ' + formatTps(tps) + ' ' + t('unit'),
        modeLabel,
        t('activeSessions', { count: active }),
      ].join(' · ');

      if (wide === false) {
        return h(
          'button',
          {
            type: 'button',
            className: busy ? 'dshfm-rail' : 'dshfm-rail dshfm-rest',
            title,
            'aria-label': title,
            style: display.color ? { color: display.color } : undefined,
            onClick: () => writeSettings({ total: mode === 'sum' ? 'avg' : 'sum' }),
          },
          h('span', { className: 'dshfm-rail-num' }, formatTps(tps)),
        );
      }

      return h(
        'div',
        {
          className: busy ? 'dshfm-quota' : 'dshfm-quota dshfm-rest',
          role: 'group',
          title,
          'aria-label': title,
          // 自定义配色走一个变量：数值、圆点与图表共用同一个强调色。
          style: display.color ? { '--dshfm-accent': display.color } : undefined,
        },
        h(
          'div',
          { className: 'dshfm-quota-head' },
          h('span', { className: 'dshfm-dot' + (busy ? ' dshfm-dot-live' : '') }),
          h('span', { className: 'dshfm-quota-label' }, mode === 'avg' ? t('modeAvg') : t('totalTag')),
          h('span', { className: 'dshfm-quota-value' }, formatTps(tps)),
          h('span', { className: 'dshfm-quota-unit' }, t('unit')),
          h('span', { className: 'dshfm-quota-sep', 'aria-hidden': true }, '·'),
          h(
            'span',
            { className: 'dshfm-quota-sessions' },
            t('activeSessions', { count: active }),
          ),
          h(
            'div',
            { className: 'dshfm-quota-seg', role: 'group', 'aria-label': t('modeGroup') },
            TOTAL_MODES.map((option) =>
              h(
                'button',
                {
                  key: option,
                  type: 'button',
                  className: 'dshfm-quota-segbtn',
                  'aria-pressed': mode === option,
                  onClick: () => writeSettings({ total: option }),
                },
                t(option === 'avg' ? 'modeAvg' : 'modeSum'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshfm-quota-chart' },
          h(SidebarTrend, { values: bars, peak }),
        ),
      );
    }

    /** 一个圆形色块（设置面板用）。 */
    function Swatch({ value, label, selected, onPick }) {
      return h('button', {
        type: 'button',
        className: 'dshfmf-swatch',
        title: label,
        'aria-label': label,
        'aria-pressed': selected,
        style: { background: value || 'var(--dsw-alias-brand-primary, #3d6df6)' },
        onClick: onPick,
      });
    }

    /**
     * 插件设置面板：渲染在「插件」页里本插件的那一页（`plugins.bundle.config`，按包名 keyed）。
     * 纯展示偏好，存 localStorage；改完读数立刻跟着变，不需要重启插件。
     * @param {{ t?: Function, view?: string }} props - slot 注入的属性；`view` 为 'summary'
     *   时只回一行摘要（该槽位正常只在 'page' 下渲染）。
     */
    function FlowmeterSettings({ t: translate, view }) {
      const t = translator(translate);
      const display = useSettings();
      const chartLabel = t(display.chart === 'curve' ? 'chartCurve' : 'chartBars');
      const modeLabel = t(display.total === 'avg' ? 'modeAvg' : 'modeSum');
      const spanLabel = display.span + 's';
      if (view === 'summary') {
        return h(
          'span',
          { className: 'dshfmf-hint' },
          t('settingsColour') + ' · ' + chartLabel + ' · ' + spanLabel + ' · ' + modeLabel,
        );
      }
      return h(
        'div',
        { className: 'dshfmf-root' },
        h(
          'div',
          { className: 'dshfmf-row' },
          h(
            'div',
            { className: 'dshfmf-text' },
            h('span', { className: 'dshfmf-label' }, t('settingsColour')),
            h('span', { className: 'dshfmf-hint' }, t('settingsColourHint')),
          ),
          h(
            'div',
            { className: 'dshfmf-controls' },
            COLOUR_PRESETS.map((preset) =>
              h(Swatch, {
                key: preset.value === '' ? 'default' : preset.value,
                value: preset.value,
                label: t(preset.label),
                selected: display.color === preset.value,
                onPick: () => writeSettings({ color: preset.value }),
              }),
            ),
            h('input', {
              type: 'color',
              className: 'dshfmf-custom',
              value: display.color || '#3d6df6',
              title: t('optionCustom'),
              'aria-label': t('optionCustom'),
              onChange: (event) => writeSettings({ color: event.target.value }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dshfmf-row' },
          h(
            'div',
            { className: 'dshfmf-text' },
            h('span', { className: 'dshfmf-label' }, t('settingsChart')),
            h('span', { className: 'dshfmf-hint' }, t('settingsChartHint')),
          ),
          h(
            'div',
            { className: 'dshfmf-seg' },
            CHART_KINDS.map((kind) =>
              h(
                'button',
                {
                  key: kind,
                  type: 'button',
                  className: 'dshfmf-segbtn',
                  'aria-pressed': display.chart === kind,
                  onClick: () => writeSettings({ chart: kind }),
                },
                t(kind === 'curve' ? 'chartCurve' : 'chartBars'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshfmf-row' },
          h(
            'div',
            { className: 'dshfmf-text' },
            h('span', { className: 'dshfmf-label' }, t('settingsSpan')),
            h('span', { className: 'dshfmf-hint' }, t('settingsSpanHint')),
          ),
          h(
            'div',
            { className: 'dshfmf-seg' },
            TREND_SPANS.map((seconds) =>
              h(
                'button',
                {
                  key: seconds,
                  type: 'button',
                  className: 'dshfmf-segbtn',
                  'aria-pressed': display.span === seconds,
                  onClick: () => writeSettings({ span: seconds }),
                },
                seconds + 's',
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshfmf-row' },
          h(
            'div',
            { className: 'dshfmf-text' },
            h('span', { className: 'dshfmf-label' }, t('settingsTotal')),
            h('span', { className: 'dshfmf-hint' }, t('settingsTotalHint')),
          ),
          h(
            'div',
            { className: 'dshfmf-seg' },
            TOTAL_MODES.map((mode) =>
              h(
                'button',
                {
                  key: mode,
                  type: 'button',
                  className: 'dshfmf-segbtn',
                  'aria-pressed': display.total === mode,
                  onClick: () => writeSettings({ total: mode }),
                },
                t(mode === 'avg' ? 'modeAvg' : 'modeSum'),
              ),
            ),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-flowmeter: dictionaries');
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-flowmeter';
        tag.dataset.pluginCss = 'dsh-flowmeter/flowmeter.css';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-flowmeter: stylesheet');
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-flowmeter', locale: NS },
          FlowmeterSettings,
        ),
      );
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            // 接替官网那枚「输出速度」统计格：同 id + 同 order + 更低 priority 即替换。
            // 不新开一格，是为了让读数排在整行最前面，同时让原来那枚整步平均速度不再显示。
            id: 'activity',
            order: 0,
            priority: -1,
            locale: NS,
          },
          FlowmeterPill,
        ),
      );
      // 侧栏底部：挂在 Settings 旁边的一组动作里。新 id 是新增一格，不会顶掉任何官方控件。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-flowmeter-total',
            order: 50,
            locale: NS,
          },
          SidebarMeter,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});

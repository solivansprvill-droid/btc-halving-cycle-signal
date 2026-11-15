(function () {
  "use strict";

  var GREEN = "#3ecf8e";
  var RED = "#ff5c6a";
  var SIGNAL = "#ff6a2c";
  var INK = "#ece8e1";
  var FONT = "12px ui-monospace, 'PingFang SC', 'Microsoft YaHei', sans-serif";

  var state = {
    chart: null,
    candleSeries: null,
    maLine: null,
    weeks: [],
    slots: [],
    cycles: [],
    weekByTime: new Map(),
    maByTime: new Map(),
    maPoints: [],
    maValue: null,
    lastPrice: null,
    lastTime: null,
    windowDays: 500,
    activeRange: "all",
    log: true,
    raf: 0,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, isError) {
    var el = $("status");
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  function formatAxis(price) {
    if (!Number.isFinite(price)) return "";
    if (price >= 1000) return Math.round(price).toLocaleString("en-US");
    if (price >= 1) return price.toFixed(2);
    return price.toFixed(4);
  }

  function formatPrice(price) {
    if (price == null || !Number.isFinite(price)) return "—";
    if (price >= 1000) return "$" + Math.round(price).toLocaleString("en-US");
    return "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatReturn(cycle) {
    var pct = Math.round(cycle.pct);
    var sign = pct > 0 ? "+" : "";
    var mult = cycle.multiple >= 10 ? cycle.multiple.toFixed(1) : cycle.multiple.toFixed(1);
    return sign + pct.toLocaleString("en-US") + "%（约 " + mult + " 倍）";
  }

  function formatStamp(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function readDays() {
    var cfg = window.CYCLE_CONFIG;
    var n = cfg.windowDays;
    try {
      var q = new URLSearchParams(location.search).get("days");
      if (q) n = Number(q);
    } catch (err) {
      n = cfg.windowDays;
    }
    if (!Number.isFinite(n)) n = cfg.windowDays;
    return Math.max(cfg.dayMin, Math.min(cfg.dayMax, Math.round(n)));
  }

  function writeDays(n) {
    try {
      var url = new URL(location.href);
      if (n === window.CYCLE_CONFIG.windowDays) url.searchParams.delete("days");
      else url.searchParams.set("days", String(n));
      history.replaceState(null, "", url);
    } catch (err) {
      /* 本地文件协议下可能改不了地址，忽略即可。 */
    }
  }

  function cell(text, mono) {
    var td = document.createElement("td");
    td.textContent = text;
    if (mono) td.className = "num";
    return td;
  }

  function renderHero() {
    var days = state.windowDays;
    $("title-days").textContent = String(days);
    $("sub-before").textContent = String(days);
    $("sub-after").textContent = String(days);
    document.title = "比特币减半 ±" + days + " 天周期信号";

    var today = Cycle.shanghaiToday();
    var focus = Cycle.focusCycle(state.cycles, today);
    var sentence = $("count-sentence");
    var sub = $("count-sub");
    if (!focus) {
      sentence.textContent = "没有可计算的买入信号";
      sentence.classList.remove("is-near");
      $("count-days").textContent = "—";
      sub.textContent = "—";
    } else {
      var delta = Cycle.daysBetween(today, focus.buyDate);
      if (delta > 0) {
        sentence.textContent = "距离下一个买入信号还有 " + delta + " 天";
        sentence.classList.toggle("is-near", delta <= 45);
        $("count-days").textContent = String(delta);
      } else if (delta === 0) {
        sentence.textContent = "信号已亮起，就是今天";
        sentence.classList.add("is-near");
        $("count-days").textContent = "0";
      } else {
        sentence.textContent = "信号已亮起，已过 " + Math.abs(delta) + " 天";
        sentence.classList.add("is-near");
        $("count-days").textContent = String(Math.abs(delta));
      }
      var tag = focus.estimated ? "预计减半" : "减半";
      sub.textContent = focus.buyDate + "  →  " + focus.sellDate + "   ·   " + focus.halvingDate + " " + tag;
    }

    $("price-now").textContent = formatPrice(state.lastPrice);
    $("price-hint").textContent = state.lastTime ? "最近日收盘 · " + Cycle.formatDate(state.lastTime) : "最近日收盘";
    $("ma-now").textContent = formatPrice(state.maValue);
    var gap = $("ma-gap");
    var gapLabel = $("ma-gap-label");
    if (state.maValue == null || state.lastPrice == null) {
      gap.textContent = "—";
      gap.className = "value num";
      gapLabel.textContent = "均线样本不足";
      return;
    }
    var pct = ((state.lastPrice - state.maValue) / state.maValue) * 100;
    var sign = pct > 0 ? "+" : "";
    gap.textContent = sign + pct.toFixed(1) + "%";
    if (pct > 0.05) {
      gap.className = "value num up";
      gapLabel.textContent = "高于均线";
    } else if (pct < -0.05) {
      gap.className = "value num down";
      gapLabel.textContent = "低于均线";
    } else {
      gap.className = "value num flat";
      gapLabel.textContent = "贴着均线";
    }
  }

  function priceText(price, missingLabel) {
    if (price == null) return missingLabel || "—";
    return formatPrice(price);
  }

  function renderTable() {
    var body = $("table-body");
    body.replaceChildren();
    state.cycles.forEach(function (cycle) {
      var tr = document.createElement("tr");
      if (cycle.status === "open" || cycle.status === "upcoming") tr.className = "is-open";
      var buy = cell(priceText(cycle.buyPrice, cycle.status === "insufficient" ? "数据不足" : "—"), true);
      var sell = cell(priceText(cycle.sellPrice, "—"), true);
      if (cycle.buyWeek) buy.title = "周收盘 " + Cycle.formatDate(cycle.buyWeek.closeTime);
      if (cycle.sellWeek) sell.title = "周收盘 " + Cycle.formatDate(cycle.sellWeek.closeTime);
      var ret = cell("—", true);
      if (cycle.status === "complete") {
        ret.textContent = formatReturn(cycle);
        ret.className = "num up";
      } else if (cycle.status === "upcoming" || cycle.status === "open") {
        ret.textContent = "进行中";
        ret.className = "num pending";
      } else {
        ret.textContent = "数据不足";
        ret.className = "num";
      }
      tr.append(cell("第" + cycle.index + "轮", false), cell(cycle.buyDate, true), buy, cell(cycle.sellDate, true), sell, ret);
      body.append(tr);
    });

    var done = state.cycles.filter(function (cycle) {
      return cycle.status === "complete";
    });
    var focus = Cycle.focusCycle(state.cycles, Cycle.shanghaiToday());
    $("summary-line").textContent =
      "当前 ±" + state.windowDays + " 天 · 已完成 " + done.length + " 轮" + (focus ? " · 下一买入 " + focus.buyDate : "");

    var note = $("table-note");
    note.replaceChildren();
    if (Cycle.returnsDecreasing(state.cycles)) {
      var strong = document.createElement("strong");
      strong.textContent = "每轮收益递减。";
      note.append(strong);
    } else {
      note.textContent = "按当前 ±" + state.windowDays + " 天，已完成周期的收益并未逐轮递减。";
    }
  }

  function updateRangeTitles() {
    state.cycles.forEach(function (cycle) {
      var btn = document.querySelector('[data-range="cycle-' + cycle.index + '"]');
      if (btn) btn.title = cycle.buyDate + " → " + cycle.sellDate;
    });
  }

  function buildRangeButtons() {
    var box = $("ranges");
    box.replaceChildren();
    var items = [{ id: "all", label: "全部" }];
    state.cycles.forEach(function (cycle) {
      items.push({ id: "cycle-" + cycle.index, label: "第" + cycle.index + "轮" });
    });
    items.push({ id: "2y", label: "最近 2 年" });
    items.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.range = item.id;
      btn.textContent = item.label;
      btn.addEventListener("click", function () {
        applyRange(item.id);
      });
      box.append(btn);
    });
    updateRangeTitles();
  }

  function setSpan(fromTs, toTs) {
    var origin = state.slots[0].time;
    var from = (fromTs - origin) / Cycle.WEEK;
    var to = (toTs - origin) / Cycle.WEEK;
    state.chart.timeScale().setVisibleLogicalRange({
      from: Math.max(-2, from),
      to: Math.min(state.slots.length + 2, to),
    });
  }

  function applyRange(id) {
    state.activeRange = id;
    document.querySelectorAll("#ranges button").forEach(function (btn) {
      var on = btn.dataset.range === id;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (!state.chart || !state.slots.length) return;
    if (id === "all") {
      state.chart.timeScale().setVisibleLogicalRange({
        from: -1,
        to: state.slots.length + 1,
      });
      return;
    }
    if (id === "2y") {
      var lastWeek = state.weeks[state.weeks.length - 1].time;
      var focus = Cycle.focusCycle(state.cycles, Cycle.shanghaiToday());
      var right = Math.max(lastWeek, focus ? focus.buyTs : lastWeek) + 3 * Cycle.WEEK;
      setSpan(right - 104 * Cycle.WEEK, right);
      return;
    }
    if (id.indexOf("cycle-") === 0) {
      var index = Number(id.slice(6));
      var cycle = state.cycles.find(function (item) {
        return item.index === index;
      });
      if (!cycle) return;
      setSpan(cycle.buyTs - 8 * Cycle.WEEK, cycle.sellTs + 6 * Cycle.WEEK);
    }
  }

  function setWindowDays(days, fromUser) {
    var cfg = window.CYCLE_CONFIG;
    var n = Math.max(cfg.dayMin, Math.min(cfg.dayMax, Math.round(Number(days))));
    state.windowDays = n;
    state.cycles = Cycle.buildCycles(cfg.halvings, n, state.weeks);
    $("window-days").value = String(n);
    $("window-readout").textContent = "±" + n + " 天";
    renderHero();
    renderTable();
    updateRangeTitles();
    requestDraw();
    if (fromUser) writeDays(n);
  }

  function xForTs(ts) {
    if (!state.chart || !state.slots.length) return null;
    var idx = (ts - state.slots[0].time) / Cycle.WEEK;
    var scale = state.chart.timeScale();
    var range = scale.getVisibleLogicalRange();
    if (!range || range.to === range.from) return scale.logicalToCoordinate(Math.round(idx));
    var x1 = scale.logicalToCoordinate(range.from);
    var x2 = scale.logicalToCoordinate(range.to);
    if (x1 == null || x2 == null) return scale.logicalToCoordinate(Math.round(idx));
    return x1 + ((idx - range.from) * (x2 - x1)) / (range.to - range.from);
  }

  function paneBox() {
    var host = $("chart-host");
    var tsHeight = 28;
    try {
      if (typeof state.chart.timeScale().height === "function") {
        var h = state.chart.timeScale().height();
        if (h > 8) tsHeight = h;
      }
    } catch (err) {
      tsHeight = 28;
    }
    var width = state.chart.timeScale().width();
    if (!width || width < 20) width = Math.max(20, host.clientWidth - 64);
    return { width: width, height: Math.max(20, host.clientHeight - tsHeight) };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawChip(ctx, anchorX, y, lines, color, paneW, occupied) {
    ctx.save();
    ctx.font = FONT;
    var padX = 6;
    var padY = 4;
    var lineH = 15;
    var textW = 0;
    lines.forEach(function (line) {
      textW = Math.max(textW, ctx.measureText(line).width);
    });
    var w = Math.ceil(textW) + padX * 2;
    var h = lines.length * lineH + padY * 2;
    var preferLeft = anchorX > paneW * 0.72;
    var left = preferLeft ? anchorX - w - 8 : anchorX + 8;
    if (left < 4 || left + w > paneW - 4) left = preferLeft ? anchorX + 8 : anchorX - w - 8;
    left = Math.max(4, Math.min(left, Math.max(4, paneW - w - 4)));
    var top = Math.max(4, y);
    if (occupied) {
      for (var guard = 0; guard < 8; guard++) {
        var box = { left: left, top: top, right: left + w, bottom: top + h };
        var hit = occupied.some(function (item) {
          return !(box.right < item.left || box.left > item.right || box.bottom < item.top || box.top > item.bottom);
        });
        if (!hit) break;
        top += h + 4;
      }
      occupied.push({ left: left, top: top, right: left + w, bottom: top + h });
    }
    ctx.fillStyle = "rgba(8, 9, 11, 0.9)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    roundRect(ctx, left, top, w, h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    lines.forEach(function (line, i) {
      ctx.fillText(line, left + padX, top + padY + i * lineH);
    });
    ctx.restore();
  }

  function drawArrow(ctx, x, y, dir, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (dir === "up") {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7, y + 13);
      ctx.lineTo(x + 7, y + 13);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7, y - 13);
      ctx.lineTo(x + 7, y - 13);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawVLine(ctx, x, color, dashed, width, paneW, paneH) {
    if (x == null || x < -1 || x > paneW + 1) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [4, 4] : []);
    var px = Math.round(x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, paneH);
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlay() {
    if (!state.chart || !state.slots.length) return;
    var canvas = $("overlay");
    var box = paneBox();
    var dpr = window.devicePixelRatio || 1;
    canvas.style.width = box.width + "px";
    canvas.style.height = box.height + "px";
    canvas.width = Math.max(1, Math.floor(box.width * dpr));
    canvas.height = Math.max(1, Math.floor(box.height * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, box.width, box.height);
    ctx.clip();

    var range = state.chart.timeScale().getVisibleLogicalRange();
    var bars = range ? range.to - range.from : 999;
    var compact = bars > 280;
    var tiny = bars > 560;
    var today = Cycle.shanghaiToday();
    var focus = Cycle.focusCycle(state.cycles, today);
    var occupied = [];

    state.cycles.forEach(function (cycle) {
      var x1 = xForTs(cycle.buyTs);
      var x2 = xForTs(cycle.sellTs);
      if (x1 == null || x2 == null) return;
      var left = Math.min(x1, x2);
      var right = Math.max(x1, x2);
      if (right < 0 || left > box.width) return;
      ctx.fillStyle = "rgba(62, 207, 142, 0.10)";
      ctx.fillRect(left, 0, right - left, box.height);
    });

    window.CYCLE_CONFIG.halvings.forEach(function (item) {
      var ts = Cycle.parseDate(item.date);
      var x = xForTs(ts);
      drawVLine(ctx, x, "rgba(236, 232, 225, 0.38)", true, 1, box.width, box.height);
      if (x == null || x < -40 || x > box.width + 40) return;
      var label = item.estimated ? "预计减半" : "减半";
      var lines = tiny ? [item.date.slice(0, 4)] : [label, item.date];
      drawChip(ctx, x, 8, lines, INK, box.width, occupied);
    });

    if (focus) {
      var signalX = xForTs(focus.buyTs);
      drawVLine(ctx, signalX, SIGNAL, false, 2, box.width, box.height);
      if (signalX != null && signalX > -80 && signalX < box.width + 80) {
        var future = Cycle.daysBetween(today, focus.buyDate) > 0;
        var signalLines = tiny && box.width < 640
          ? [future ? "下一买点" : "买点已亮", focus.buyDate]
          : [future ? "下一个买入信号" : "买入信号已亮起", focus.buyDate];
        drawChip(ctx, signalX, 8, signalLines, SIGNAL, box.width, occupied);
      }
    }

    state.cycles.forEach(function (cycle) {
      if (cycle.buyWeek && cycle.buyPrice != null) {
        var bx = xForTs(cycle.buyWeek.time);
        var by = state.candleSeries.priceToCoordinate(cycle.buyWeek.low);
        if (bx != null && by != null && bx > -20 && bx < box.width + 20) {
          var buyY = Math.min(box.height - 36, by + 10);
          drawArrow(ctx, bx, buyY, "up", GREEN);
          drawChip(
            ctx,
            bx,
            buyY + 16,
            tiny ? ["买"] : compact ? ["买", formatPrice(cycle.buyPrice)] : ["买 " + cycle.buyDate, formatPrice(cycle.buyPrice)],
            GREEN,
            box.width,
            occupied
          );
        }
      }
      if (cycle.sellWeek && cycle.sellPrice != null) {
        var sx = xForTs(cycle.sellWeek.time);
        var sy = state.candleSeries.priceToCoordinate(cycle.sellWeek.high);
        if (sx != null && sy != null && sx > -20 && sx < box.width + 20) {
          var sellY = Math.max(28, sy - 10);
          drawArrow(ctx, sx, sellY, "down", RED);
          drawChip(
            ctx,
            sx,
            Math.max(4, sellY - (tiny ? 28 : 46)),
            tiny ? ["卖"] : compact ? ["卖", formatPrice(cycle.sellPrice)] : ["卖 " + cycle.sellDate, formatPrice(cycle.sellPrice)],
            RED,
            box.width,
            occupied
          );
        }
      }
    });

    if (state.weeks.length && state.lastPrice != null) {
      var last = state.weeks[state.weeks.length - 1];
      var lx = xForTs(last.time);
      var ly = state.candleSeries.priceToCoordinate(state.lastPrice);
      if (lx != null && ly != null && lx > 0 && lx < box.width && ly > 12 && ly < box.height - 12) {
        drawChip(ctx, lx, ly - 14, ["现价 " + formatPrice(state.lastPrice)], INK, box.width, null);
      }
    }

    ctx.restore();
  }

  function requestDraw() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(function () {
      state.raf = 0;
      drawOverlay();
    });
  }

  function onCrosshair(param) {
    var tip = $("tip");
    if (!param || !param.point || param.time == null || !param.seriesData) {
      tip.hidden = true;
      return;
    }
    var bar = param.seriesData.get(state.candleSeries);
    if (!bar || bar.open == null) {
      tip.hidden = true;
      return;
    }
    var week = state.weekByTime.get(param.time);
    var incomplete = week && week.closeTime < week.time + 6 * 86400;
    tip.replaceChildren();
    var title = document.createElement("strong");
    title.textContent = Cycle.formatDate(param.time) + " 至 " + Cycle.formatDate(param.time + 6 * 86400) + (incomplete ? " · 未完" : "");
    tip.append(title);
    [["开", bar.open], ["高", bar.high], ["低", bar.low], ["收", bar.close]].forEach(function (pair) {
      var row = document.createElement("div");
      var name = document.createElement("span");
      name.textContent = pair[0];
      row.append(name, document.createTextNode(formatPrice(pair[1])));
      tip.append(row);
    });
    var ma = state.maByTime.get(param.time);
    if (ma != null) {
      var maRow = document.createElement("div");
      var maName = document.createElement("span");
      maName.textContent = "200周";
      maRow.append(maName, document.createTextNode(formatPrice(ma)));
      tip.append(maRow);
    }
    tip.hidden = false;
    var host = $("chart-host");
    var left = param.point.x + 16;
    var top = param.point.y + 16;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    if (left + tip.offsetWidth > host.clientWidth - 8) left = param.point.x - tip.offsetWidth - 12;
    if (top + tip.offsetHeight > host.clientHeight - 8) top = param.point.y - tip.offsetHeight - 12;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }

  function setScale(log) {
    state.log = log;
    if (state.chart) {
      state.chart.priceScale("right").applyOptions({
        mode: log ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal,
      });
    }
    $("scale-log").classList.toggle("is-on", log);
    $("scale-linear").classList.toggle("is-on", !log);
    $("scale-log").setAttribute("aria-pressed", log ? "true" : "false");
    $("scale-linear").setAttribute("aria-pressed", log ? "false" : "true");
    requestDraw();
  }

  function initChart() {
    var host = $("chart-host");
    var chart = LightweightCharts.createChart($("chart"), {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: "#0c0e12" },
        textColor: "#8d887f",
        fontFamily: "ui-monospace, Consolas, 'Microsoft YaHei', sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(236,232,225,0.045)" },
        horzLines: { color: "rgba(236,232,225,0.045)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "rgba(236,232,225,0.28)", labelBackgroundColor: "#2a2622" },
        horzLine: { color: "rgba(236,232,225,0.28)", labelBackgroundColor: "#2a2622" },
      },
      rightPriceScale: {
        borderColor: "rgba(236,232,225,0.1)",
        mode: LightweightCharts.PriceScaleMode.Logarithmic,
        scaleMargins: { top: 0.16, bottom: 0.12 },
      },
      timeScale: {
        borderColor: "rgba(236,232,225,0.1)",
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 3,
        minBarSpacing: 0.15,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      localization: {
        locale: "zh-CN",
        timeFormatter: function (time) {
          return Cycle.formatDate(time) + " 当周";
        },
      },
    });

    var priceFormat = { type: "custom", minMove: 0.01, formatter: formatAxis };
    var candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: GREEN,
      downColor: RED,
      borderUpColor: GREEN,
      borderDownColor: RED,
      wickUpColor: GREEN,
      wickDownColor: RED,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: "#ece8e1",
      priceLineStyle: LightweightCharts.LineStyle.Dashed,
      priceFormat: priceFormat,
    });
    var maLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: "#f0a202",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: priceFormat,
    });
    candleSeries.setData(state.slots.map(function (slot) {
      if (!slot.candle) return { time: slot.time };
      return {
        time: slot.time,
        open: slot.candle.open,
        high: slot.candle.high,
        low: slot.candle.low,
        close: slot.candle.close,
      };
    }));
    maLine.setData(state.maPoints.map(function (point) {
      return { time: point.time, value: point.value };
    }));
    chart.timeScale().subscribeVisibleLogicalRangeChange(requestDraw);
    chart.subscribeCrosshairMove(onCrosshair);
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
        requestDraw();
      }).observe(host);
    } else {
      window.addEventListener("resize", function () {
        chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
        requestDraw();
      });
    }
    state.chart = chart;
    state.candleSeries = candleSeries;
    state.maLine = maLine;
  }

  function prepare(payload, days) {
    var cfg = window.CYCLE_CONFIG;
    state.weeks = Cycle.aggregateWeeks(payload.daily);
    if (state.weeks.length < 20) throw new Error("周线数量不足");
    state.weekByTime = new Map(state.weeks.map(function (week) {
      return [week.time, week];
    }));
    var last = payload.daily[payload.daily.length - 1];
    state.lastPrice = Number(last[4]);
    state.lastTime = Number(last[0]);
    state.maPoints = Cycle.sma(state.weeks, 200);
    state.maByTime = new Map(state.maPoints.map(function (point) {
      return [point.time, point.value];
    }));
    state.maValue = state.maPoints.length ? state.maPoints[state.maPoints.length - 1].value : null;
    var lastHalving = cfg.halvings[cfg.halvings.length - 1];
    var until = Cycle.parseDate(lastHalving.date) + (cfg.dayMax + 28) * 86400;
    state.slots = Cycle.buildSlots(state.weeks, until);
    state.windowDays = days;
    state.cycles = Cycle.buildCycles(cfg.halvings, days, state.weeks);
  }

  function renderFooter(payload) {
    var updated = $("updated");
    updated.textContent = formatStamp(payload.updatedAt);
    if (payload.updatedAt) updated.setAttribute("datetime", payload.updatedAt);
    var from = payload.from || Cycle.formatDate(payload.daily[0][0]);
    var to = payload.to || Cycle.formatDate(payload.daily[payload.daily.length - 1][0]);
    $("data-span").textContent = "覆盖 " + from + " 至 " + to + " · " + Number(payload.count || payload.daily.length).toLocaleString("en-US") + " 根日线";
  }

  async function loadLocal() {
    var res = await fetch("data/data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("data.json HTTP " + res.status);
    var json = await res.json();
    if (!json.daily || json.daily.length < 100) throw new Error("data.json 不完整");
    return json;
  }

  async function fetchBitstamp() {
    var step = 86400;
    var limit = 1000;
    var target = Date.UTC(2011, 7, 1) / 1000;
    var end = Math.floor(Date.now() / 1000) + step;
    var map = new Map();
    for (var i = 0; i < 40 && end > target; i++) {
      setStatus("正在从 Bitstamp 拉取历史日线（第 " + (i + 1) + " 页）…");
      var res = await fetch("https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=" + step + "&limit=" + limit + "&end=" + end);
      if (!res.ok) throw new Error("Bitstamp HTTP " + res.status);
      var json = await res.json();
      var rows = (json.data && json.data.ohlc) || [];
      if (!rows.length) break;
      var oldest = Infinity;
      rows.forEach(function (row) {
        var t = Number(row.timestamp);
        if (!Number.isFinite(t)) return;
        oldest = Math.min(oldest, t);
        map.set(t, [t, Number(row.open), Number(row.high), Number(row.low), Number(row.close)]);
      });
      if (oldest <= target) break;
      var next = oldest - step;
      if (!(next < end)) break;
      end = next;
    }
    var daily = Array.from(map.values()).filter(function (row) {
      return row[0] >= target && Number.isFinite(row[4]);
    }).sort(function (a, b) {
      return a[0] - b[0];
    });
    if (daily.length < 100) throw new Error("Bitstamp 返回的日线太少");
    return {
      source: "Bitstamp",
      updatedAt: new Date().toISOString(),
      from: Cycle.formatDate(daily[0][0]),
      to: Cycle.formatDate(daily[daily.length - 1][0]),
      count: daily.length,
      daily: daily,
      live: true,
    };
  }

  async function boot() {
    if (!window.LightweightCharts || !window.Cycle || !window.CYCLE_CONFIG) {
      setStatus("页面脚本没有载入完整。", true);
      $("chart-msg").textContent = "脚本没有载入完整";
      return;
    }
    var cfg = window.CYCLE_CONFIG;
    var slider = $("window-days");
    slider.min = String(cfg.dayMin);
    slider.max = String(cfg.dayMax);
    var initial = readDays();
    slider.value = String(initial);
    $("window-readout").textContent = "±" + initial + " 天";
    slider.addEventListener("input", function () {
      setWindowDays(slider.value, true);
    });
    $("reset-days").addEventListener("click", function () {
      setWindowDays(cfg.windowDays, true);
    });
    $("scale-log").addEventListener("click", function () {
      setScale(true);
    });
    $("scale-linear").addEventListener("click", function () {
      setScale(false);
    });

    var payload;
    var fromFile = false;
    try {
      payload = await loadLocal();
      fromFile = true;
    } catch (err) {
      try {
        payload = await fetchBitstamp();
      } catch (liveErr) {
        setStatus("行情加载失败。请确认 data/data.json 可以访问，或当前网络能打开 Bitstamp。", true);
        $("chart-msg").textContent = "行情没有加载成功";
        return;
      }
    }

    try {
      prepare(payload, initial);
    } catch (err) {
      setStatus(err.message || "行情处理失败", true);
      return;
    }
    renderFooter(payload);
    renderHero();
    renderTable();
    initChart();
    buildRangeButtons();
    applyRange(window.innerWidth < 760 ? "2y" : "all");
    $("chart-msg").hidden = true;
    setStatus(fromFile ? "已读取本地 data.json。悬停或点击 K 线可看当周开高低收。" : "本地数据不可用，已改用 Bitstamp 实时接口。");
    requestDraw();
    setInterval(renderHero, 60000);
  }

  boot();
})();

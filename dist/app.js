"use strict";
function getEl(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`#${id} not found in the DOM`);
    return found;
}
function readEmbeddedJson(id) {
    const el = document.getElementById(id);
    if (!el || !el.textContent)
        throw new Error(`Missing embedded data script #${id}`);
    return JSON.parse(el.textContent);
}
const GRAPH = readEmbeddedJson("graph-data");
const CHAR_LEGEND = readEmbeddedJson("char-legend-data");
const cv = getEl("cv");
const ctx = cv.getContext("2d");
const mm = getEl("minimap");
const mmCtx = mm.getContext("2d");
const tooltip = getEl("tooltip");
const THEME_LIGHT = {
    bg: "#f4f4f7", edge: "#8a8a96", edgeDim: "#e2e2e8", nodeDefault: "#e7e7ee", nodeBorder: "#c6c6d1",
    text: "#202024", textOnColor: "#151517", accent: "#1b6fd6", accent2: "#a15e00",
    panel: "#ffffff", panelBorder: "#dcdce2", mmBg: "#e7e8f0", mmDot: "#5c5c6c",
};
const THEME_DARK = {
    bg: "#1e1e22", edge: "#82828f", edgeDim: "#34343c", nodeDefault: "#3a3a42", nodeBorder: "#54545f",
    text: "#eceef2", textOnColor: "#12121a", accent: "#5fb3ff", accent2: "#ffcf5c",
    panel: "#2a2a30", panelBorder: "#3d3d45", mmBg: "#46464f", mmDot: "#cfcfdc",
};
let isLight;
let THEME;
function currentThemeMode() {
    let stored = null;
    try {
        stored = localStorage.getItem("ntrsim-theme");
    }
    catch { }
    if (stored === "light" || stored === "dark")
        return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(mode) {
    isLight = mode === "light";
    THEME = isLight ? THEME_LIGHT : THEME_DARK;
    document.documentElement.dataset.theme = mode;
    const btn = document.getElementById("themeBtn");
    if (btn)
        btn.textContent = isLight ? "Dark mode" : "Light mode";
    buildLegend();
    draw();
}
const byId = new Map(GRAPH.nodes.map((n) => [n.id, n]));
const children = new Map();
const parents = new Map();
const outEdges = new Map();
const inEdges = new Map();
for (const n of GRAPH.nodes) {
    children.set(n.id, []);
    parents.set(n.id, []);
    outEdges.set(n.id, []);
    inEdges.set(n.id, []);
}
for (const e of GRAPH.edges) {
    if (!byId.has(e.f) || !byId.has(e.t))
        continue;
    children.get(e.f).push(e.t);
    parents.get(e.t).push(e.f);
    outEdges.get(e.f).push(e);
    inEdges.get(e.t).push(e);
}
const edgeDetour = new Map();
{
    const CELL = 200;
    const grid = new Map();
    for (const n of GRAPH.nodes) {
        if (n.j)
            continue;
        for (let cx = Math.floor(n.x / CELL); cx <= Math.floor((n.x + n.w) / CELL); cx++)
            for (let cy = Math.floor(n.y / CELL); cy <= Math.floor((n.y + n.h) / CELL); cy++) {
                const k = cx + "," + cy;
                if (!grid.has(k))
                    grid.set(k, []);
                grid.get(k).push(n);
            }
    }
    const blockersOf = (p, a, b) => {
        const hit = new Set();
        const segs = (p.length - 2) / 6;
        for (let i = 1; i < 48 * segs; i++) {
            const [x, y] = pathPoint(p, i / (48 * segs));
            for (const n of grid.get(Math.floor(x / CELL) + "," + Math.floor(y / CELL)) ?? []) {
                if (n === a || n === b)
                    continue;
                if (x > n.x - 6 && x < n.x + n.w + 6 && y > n.y - 6 && y < n.y + n.h + 6)
                    hit.add(n);
            }
        }
        return hit;
    };
    for (const e of GRAPH.edges) {
        if (e.par)
            continue;
        const a = byId.get(e.f), b = byId.get(e.t);
        if (!a || !b)
            continue;
        const x0 = a.x + a.w / 2, y0 = a.y + a.h, x3 = b.x + b.w / 2 + edgeArrivalOffset(e, b), y3 = b.y;
        const dy = Math.max(40, Math.abs(y3 - y0) / 2);
        const inWay = [...blockersOf([x0, y0, x0, y0 + dy, x3, y3 - dy, x3, y3], a, b)];
        if (!inWay.length)
            continue;
        // Swing out in the gap just below the source and back in the gap just
        // above the target, so the straight side run covers every node in the way.
        const yA = Math.max(y0 + 12, Math.min(...inWay.map((n) => n.y)) - 10);
        const yB = Math.min(y3 - 12, Math.max(...inWay.map((n) => n.y + n.h)) + 10);
        // Try the right and left, further out each step; keep the first
        // (smallest) swing that clears every node, else the one hitting fewest.
        let best = null;
        for (let step = 1; step <= 30 && !(best && best[0] === 0); step++) {
            for (const side of [1, -1]) {
                const xs = inWay.map((n) => (side > 0 ? n.x + n.w : n.x));
                const c = side > 0 ? Math.max(...xs) + 30 * step : Math.min(...xs) - 30 * step;
                const d = { c, yA, yB };
                const hits = blockersOf(detourPoints(x0, y0, x3, y3, d), a, b).size;
                if (!best || hits < best[0])
                    best = [hits, d];
                if (hits === 0)
                    break;
            }
        }
        if (best)
            edgeDetour.set(e.id, best[1]);
    }
}
/** A detoured edge's path as joined cubic segments (x0,y0 then three points
 *  per segment): an S-bend out to x = `c`, straight down, an S-bend back in.
 *  Both bends leave and arrive vertically, like a normal edge. */
function detourPoints(x0, y0, x3, y3, d) {
    const h1 = (d.yA - y0) / 2, h2 = (y3 - d.yB) / 2, run = (d.yB - d.yA) / 3;
    return [
        x0, y0, x0, y0 + h1, d.c, d.yA - h1, d.c, d.yA,
        d.c, d.yA + run, d.c, d.yB - run, d.c, d.yB,
        d.c, d.yB + h2, x3, y3 - h2, x3, y3,
    ];
}
/** Point at `t` (0..1) along a path of joined cubic segments, each segment
 *  taking an equal share of `t`. */
function pathPoint(p, t) {
    const segs = (p.length - 2) / 6;
    const k = Math.min(segs - 1, Math.floor(t * segs)), u = t * segs - k, o = k * 6;
    return bezierPoint(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], u);
}
/** Lines that run on top of each other for a real stretch (not just where
 *  they leave the same node or arrive at the same one) get different colors
 *  so each can be followed. Edges that overlap nothing keep the default. */
const EDGE_COLORS = ["#4a9eff", "#e8743b", "#3fb36b", "#b05ce6", "#d4a017", "#1fb5ad", "#e0508f"];
const edgeColor = new Map();
{
    // NEAR: lines this close (world units, ~4 line widths at 100%) blur into
    // one band -- e.g. several dashed lines converging on a day header at a
    // shallow angle, a few units apart for a long stretch. Lines leaving the
    // SAME node are exempt: that's an ordinary fork, which always starts out
    // side by side and is told apart by its condition labels/targets.
    const STEP = 8, NEAR = 22, CELL = 24, END_SKIP = 36, MIN_SHARED = 56;
    // Evenly spaced sample points along every edge, in world coordinates.
    const samples = new Map();
    const grid = new Map();
    for (const e of GRAPH.edges) {
        // Only the dashed (reconvergence) lines: solid tree lines are clear
        // enough on their own, and dashed-vs-solid already tells them apart.
        if (e.tree)
            continue;
        const a = byId.get(e.f), b = byId.get(e.t);
        if (!a || !b)
            continue;
        const p = edgeWorldPoints(e, a, b, 1);
        const segs = (p.length - 2) / 6, fine = 64 * segs;
        const pts = [];
        let prev = pathPoint(p, 0), acc = STEP;
        for (let i = 1; i <= fine; i++) {
            const q = pathPoint(p, i / fine);
            acc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
            prev = q;
            if (acc >= STEP) {
                acc = 0;
                pts.push(q);
            }
        }
        // Leave out the stretch next to either end: lines leaving or entering
        // the same node always start out bunched together, by design.
        const [sx, sy] = pathPoint(p, 0), [ex, ey] = pathPoint(p, 1);
        const mid = pts.filter(([x, y]) => Math.hypot(x - sx, y - sy) > END_SKIP && Math.hypot(x - ex, y - ey) > END_SKIP);
        samples.set(e, mid);
        for (const [x, y] of mid) {
            const k = Math.floor(x / CELL) + "," + Math.floor(y / CELL);
            if (!grid.has(k))
                grid.set(k, []);
            grid.get(k).push([e, x, y]);
        }
    }
    // Two edges conflict when enough of one's samples sit right on the other.
    const conflicts = new Map();
    for (const [e, pts] of samples) {
        const shared = new Map();
        for (const [x, y] of pts) {
            const seen = new Set();
            const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
            for (let i = cx - 1; i <= cx + 1; i++)
                for (let j = cy - 1; j <= cy + 1; j++)
                    for (const [o, ox, oy] of grid.get(i + "," + j) ?? []) {
                        if (o === e || o.f === e.f || seen.has(o) || Math.hypot(ox - x, oy - y) > NEAR)
                            continue;
                        seen.add(o);
                        shared.set(o, (shared.get(o) ?? 0) + 1);
                    }
        }
        for (const [o, count] of shared) {
            if (count * STEP < MIN_SHARED)
                continue;
            if (!conflicts.has(e))
                conflicts.set(e, new Set());
            if (!conflicts.has(o))
                conflicts.set(o, new Set());
            conflicts.get(e).add(o);
            conflicts.get(o).add(e);
        }
    }
    // Color per bundle (connected group of overlapping lines), not just per
    // overlapping pair: in a bundle of lines converging on one node, two lines
    // that each only touch a third would otherwise both stay plain and still
    // read as one. Slot 0 is the normal line color, so one line per bundle
    // stays plain. Only very large bundles (more lines than colors) fall back
    // to merely avoiding direct neighbours' colors.
    const SLOTS = EDGE_COLORS.length + 1;
    const slot = new Map();
    for (const start of GRAPH.edges) {
        if (!conflicts.has(start) || slot.has(start))
            continue;
        const bundle = [];
        const queue = [start], seen = new Set([start]);
        while (queue.length) {
            const e = queue.shift();
            bundle.push(e);
            for (const o of conflicts.get(e))
                if (!seen.has(o)) {
                    seen.add(o);
                    queue.push(o);
                }
        }
        const taken = new Set();
        for (const e of bundle) {
            const near = new Set([...conflicts.get(e)].map((o) => slot.get(o)));
            let s = 0;
            while (s < SLOTS && (near.has(s) || taken.has(s)))
                s++;
            if (s === SLOTS) {
                s = 0;
                while (near.has(s))
                    s++;
            }
            slot.set(e, s);
            taken.add(s);
            if (s > 0)
                edgeColor.set(e.id, EDGE_COLORS[(s - 1) % EDGE_COLORS.length]);
        }
    }
}
const rootId = GRAPH.nodes.find((n) => parents.get(n.id).length === 0)?.id ?? GRAPH.nodes[0].id;
let worldMinX = Infinity, worldMinY = Infinity, worldMaxX = -Infinity, worldMaxY = -Infinity;
for (const n of GRAPH.nodes) {
    worldMinX = Math.min(worldMinX, n.x);
    worldMinY = Math.min(worldMinY, n.y);
    worldMaxX = Math.max(worldMaxX, n.x + n.w);
    worldMaxY = Math.max(worldMaxY, n.y + n.h);
}
const dayRoutes = GRAPH.routes.filter((r) => r.kind === "day").sort((a, b) => a.y - b.y);
function nearestDayLabel(y) {
    let best = null;
    for (const r of dayRoutes) {
        if (r.y <= y + 1)
            best = r;
        else
            break;
    }
    return best ? best.label : "";
}
const pictureNodes = GRAPH.nodes.filter((n) => n.pic);
let viewMode = "tracker";
let showConditionPills = false;
let maskChoiceText = true;
let strictPathOnly = true;
let showGroups = false;
let saveState = null;
let blockedSet = new Set();
let visitedRevealSet = new Set();
let obtainedSet = new Set();
let hoveredNodeId = null;
function normalizeSave(raw) {
    const sd = raw?.files?.["storyline_data.json"];
    const au = sd?.autoload_state;
    const story = au?.Story ?? {};
    const es = au?.EventScheduler ?? {};
    const vars = {};
    for (const k in story)
        if (k !== "_flags" && k !== "_snapshot_metadata")
            vars[k] = story[k];
    const visited = [];
    const files = raw?.files ?? {};
    for (const key in files) {
        if (key === "storyline_data.json")
            continue;
        const hist = files[key]?.history;
        if (!Array.isArray(hist))
            continue;
        for (const msg of hist) {
            if (!msg.dialogue_file || msg.current_id == null || msg.current_id === "")
                continue;
            const shorthand = msg.dialogue_file.replace(/^res:\/\//, "").replace(/^assets\/dialogue\//, "").replace(/\.dialogue$/, "");
            visited.push(shorthand + ":" + msg.current_id);
        }
    }
    return {
        flags: Object.keys(story._flags ?? {}),
        completedEvents: (es.completed_events ?? []).slice(),
        activeEventId: es.active_event_id ?? null,
        currentDay: es.current_day ?? raw.metadata?.current_day ?? null,
        vars,
        visited,
        gameVersion: raw.game_version ?? null,
        saveTime: raw.metadata?.save_time ?? null,
        slotName: raw.metadata?.slot_name ?? null,
    };
}
const RE_HAS_FLAG = /^Story\.has_flag\(\s*["']([^"']+)["']\s*\)$/;
const RE_IS_EVENT_COMPLETE = /^EventScheduler\.is_event_complete\(\s*\\?["']([^"'\\]+)\\?["']\s*\)$/;
const RE_KISS_TIMES_CMP = /^Story\.mabel_get_kiss_times\(\)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;
const RE_KISSES_WITH_CMP = /^Story\.mabel_get_kisses_with\(\s*["']([^"']+)["']\s*\)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;
const RE_KISSES_WITH = /^Story\.mabel_get_kisses_with\(\s*["']([^"']+)["']\s*\)$/;
const RE_COMPARISON = /^(Story|PhoneUnlocks|EventScheduler)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;
const RE_BARE_VAR = /^(Story|PhoneUnlocks|EventScheduler)\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
function compareNum(cur, op, rhsRaw) {
    const rhs = rhsRaw.trim();
    const qm = rhs.match(/^["'](.*)["']$/);
    let rhsVal;
    if (qm)
        rhsVal = qm[1];
    else if (!isNaN(parseFloat(rhs)))
        rhsVal = parseFloat(rhs);
    else
        return null;
    if (typeof cur === "string" && typeof rhsVal !== "string")
        return null;
    const curVal = cur;
    switch (op) {
        case "==": return curVal == rhsVal;
        case "!=": return curVal != rhsVal;
        case "<": return curVal < rhsVal;
        case ">": return curVal > rhsVal;
        case "<=": return curVal <= rhsVal;
        case ">=": return curVal >= rhsVal;
        default: return null;
    }
}
function triCombine(vals, isOr) {
    let sawTrue = false, sawFalse = false, sawUnknown = false;
    for (const v of vals) {
        if (v === true)
            sawTrue = true;
        else if (v === false)
            sawFalse = true;
        else
            sawUnknown = true;
    }
    if (isOr)
        return sawTrue ? true : sawUnknown ? null : false;
    return sawFalse ? false : sawUnknown ? null : true;
}
function evalLeaf(rawExpr, sv) {
    const expr = rawExpr.trim();
    if (!expr)
        return null;
    let m;
    if ((m = expr.match(RE_HAS_FLAG))) {
        const flag = m[1];
        if (sv.flagSet.has(flag))
            return true;
        const settingEvent = GRAPH.flag_events[flag];
        if (settingEvent && sv.completedSet.has(settingEvent))
            return false;
        return null;
    }
    if ((m = expr.match(RE_IS_EVENT_COMPLETE)))
        return sv.completedSet.has(m[1]);
    const pending = (result) => (result === false ? null : result);
    if ((m = expr.match(RE_KISS_TIMES_CMP))) {
        const log = sv.vars.mabel_kiss_log;
        if (!log)
            return null;
        const total = Object.values(log).reduce((a, b) => a + (Number(b) || 0), 0);
        return pending(compareNum(total, m[1], m[2]));
    }
    if ((m = expr.match(RE_KISSES_WITH_CMP))) {
        const log = sv.vars.mabel_kiss_log;
        if (!log)
            return null;
        return pending(compareNum(log[m[1]] || 0, m[2], m[3]));
    }
    if ((m = expr.match(RE_KISSES_WITH))) {
        const log = sv.vars.mabel_kiss_log;
        if (!log)
            return null;
        return pending((log[m[1]] || 0) > 0);
    }
    if ((m = expr.match(RE_COMPARISON))) {
        const [, ns, varName, op, rhsRaw] = m;
        if (ns === "PhoneUnlocks")
            return null;
        const cur = sv.vars[varName];
        if (cur === undefined)
            return null;
        if (typeof cur === "string" && cur === "")
            return null;
        const result = compareNum(cur, op, rhsRaw);
        return typeof cur === "number" ? pending(result) : result;
    }
    if ((m = expr.match(RE_BARE_VAR))) {
        const [, ns, varName] = m;
        if (ns === "PhoneUnlocks")
            return null;
        const cur = sv.vars[varName];
        return typeof cur === "boolean" ? pending(cur) : null;
    }
    return null;
}
function evalExpr(rawExpr, sv) {
    const orParts = rawExpr.split(/\|\||\bor\b/i);
    const orVals = orParts.map((p) => {
        const andParts = p.split(/&&|\band\b/i);
        return triCombine(andParts.map((a) => evalLeaf(a, sv)), false);
    });
    return triCombine(orVals, true);
}
function evalEdge(e, sv) {
    if (!e.raw || !e.raw.length)
        return true;
    // e.raw is a list of AND-groups (alternatives), OR'd together -- see
    // build_canvas.py's render_raw/finalize_edge for how these are produced.
    const altVals = e.raw.map((group) => triCombine(group.map((expr) => evalExpr(expr, sv)), false));
    return triCombine(altVals, true);
}
function computeBlocked(rawSave) {
    const blocked = new Set();
    if (!rawSave)
        return blocked;
    const sv = {
        flagSet: new Set(rawSave.flags),
        completedSet: new Set(rawSave.completedEvents),
        vars: rawSave.vars,
    };
    const indeg = new Map();
    for (const n of GRAPH.nodes)
        indeg.set(n.id, 0);
    for (const e of GRAPH.edges)
        if (byId.has(e.f) && byId.has(e.t))
            indeg.set(e.t, indeg.get(e.t) + 1);
    const queue = GRAPH.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const topo = [];
    const work = new Map(indeg);
    while (queue.length) {
        const u = queue.shift();
        topo.push(u);
        for (const v of children.get(u) ?? []) {
            work.set(v, work.get(v) - 1);
            if (work.get(v) === 0)
                queue.push(v);
        }
    }
    const reach = new Map();
    for (const id of topo) {
        const ins = inEdges.get(id) ?? [];
        if (!ins.length) {
            reach.set(id, true);
            continue;
        }
        let ok = false;
        for (const e of ins) {
            if (!reach.get(e.f))
                continue;
            if (evalEdge(e, sv) !== false) {
                ok = true;
                break;
            }
        }
        reach.set(id, ok);
        if (!ok)
            blocked.add(id);
    }
    return blocked;
}
function computeVisited(rawSave, includeSiblings) {
    const revealed = new Set();
    if (!rawSave)
        return revealed;
    const visitedSrc = new Set(rawSave.visited);
    const pathNodeIds = new Set();
    for (const n of GRAPH.nodes) {
        if (!n.src || !n.src.length)
            continue;
        if (n.src.some((s) => visitedSrc.has(s))) {
            const p = computeAncestorPath(n.id);
            for (const id of p.nodes)
                pathNodeIds.add(id);
        }
    }
    for (const id of pathNodeIds) {
        revealed.add(id);
        if (!includeSiblings)
            continue;
        for (const p of parents.get(id) ?? []) {
            for (const sib of children.get(p) ?? [])
                revealed.add(sib);
        }
    }
    return revealed;
}
function computeObtained(rawSave) {
    const obtained = new Set();
    if (!rawSave)
        return obtained;
    const visitedSrc = new Set(rawSave.visited);
    for (const n of GRAPH.nodes) {
        if (n.src && n.src.length && n.src.some((s) => visitedSrc.has(s)))
            obtained.add(n.id);
    }
    return obtained;
}
let DPR = Math.max(1, window.devicePixelRatio || 1);
const cam = { x: 0, y: 0, scale: 0.55 };
function resize() {
    DPR = Math.max(1, window.devicePixelRatio || 1);
    cv.width = innerWidth * DPR;
    cv.height = innerHeight * DPR;
    cv.style.width = innerWidth + "px";
    cv.style.height = innerHeight + "px";
    const mmW = Math.round(Math.min(420, Math.max(190, innerWidth * 0.22)));
    const mmH = Math.round(Math.min(300, Math.max(130, innerHeight * 0.26)));
    mm.style.width = mmW + "px";
    mm.style.height = mmH + "px";
    mm.width = mmW;
    mm.height = mmH;
    draw();
}
window.addEventListener("resize", resize);
function worldToScreen(wx, wy) {
    return [(wx - cam.x) * cam.scale + cv.width / (2 * DPR), (wy - cam.y) * cam.scale + cv.height / (2 * DPR)];
}
function screenToWorld(sx, sy) {
    return [(sx - cv.width / (2 * DPR)) / cam.scale + cam.x, (sy - cv.height / (2 * DPR)) / cam.scale + cam.y];
}
function centerOn(wx, wy, scale, animate = true) {
    const target = { x: wx, y: wy, scale: scale ?? cam.scale };
    if (!animate) {
        Object.assign(cam, target);
        draw();
        return;
    }
    const start = { ...cam };
    const t0 = performance.now();
    const DUR = 420;
    function step(t) {
        let p = Math.min(1, (t - t0) / DUR);
        p = 1 - Math.pow(1 - p, 3);
        cam.x = start.x + (target.x - start.x) * p;
        cam.y = start.y + (target.y - start.y) * p;
        cam.scale = start.scale + (target.scale - start.scale) * p;
        draw();
        if (p < 1)
            requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
function fitAll(animate = true) {
    const w = worldMaxX - worldMinX, h = worldMaxY - worldMinY;
    const s = Math.min((cv.width / DPR - 80) / w, (cv.height / DPR - 80) / h, 1.2);
    centerOn((worldMinX + worldMaxX) / 2, (worldMinY + worldMaxY) / 2, Math.max(s, 0.01), animate);
}
let pathNodes = null;
let pathEdges = null;
let filterSet = null;
let groupOnly = false;
let selectedGroup = null;
const labelRects = [];
/** Route-box titles placed in the last frame; edge labels steer clear of them too. */
const groupLabelRects = [];
function computeAncestorPath(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
        const u = stack.pop();
        for (const p of parents.get(u) ?? [])
            if (!seen.has(p)) {
                seen.add(p);
                stack.push(p);
            }
    }
    const edges = new Set();
    for (const e of GRAPH.edges)
        if (seen.has(e.f) && seen.has(e.t))
            edges.add(e.id);
    return { nodes: seen, edges };
}
function ancestorConditions(id) {
    const seen = new Set([id]);
    const stack = [id];
    const labels = [];
    const labelSeen = new Set();
    while (stack.length) {
        const u = stack.pop();
        for (const e of inEdges.get(u) ?? []) {
            if (e.l && !labelSeen.has(e.l)) {
                labelSeen.add(e.l);
                labels.push(e.l);
            }
            if (!seen.has(e.f)) {
                seen.add(e.f);
                stack.push(e.f);
            }
        }
    }
    return labels;
}
function selectNode(id, animate = true) {
    const n = byId.get(id);
    if (!n)
        return;
    const p = computeAncestorPath(id);
    pathNodes = p.nodes;
    pathEdges = p.edges;
    filterSet = null;
    groupOnly = false;
    selectedGroup = null;
    getEl("results").style.display = "none";
    getEl("clearBtn").style.display = "inline-block";
    centerOn(n.x + n.w / 2, n.y + n.h / 2, Math.max(cam.scale, 0.85), animate);
}
function clearHighlight() {
    pathNodes = null;
    pathEdges = null;
    filterSet = null;
    groupOnly = false;
    selectedGroup = null;
    getEl("searchInput").value = "";
    getEl("results").style.display = "none";
    getEl("matchCount").textContent = "";
    getEl("clearBtn").style.display = "none";
    draw();
}
function isNodeVisible(n) {
    if (viewMode === "spoiler")
        return true;
    if (n.id === rootId || n.pic)
        return true;
    if (visitedRevealSet.has(n.id))
        return true;
    return !!(pathNodes && pathNodes.has(n.id));
}
function isEdgeVisible(e) {
    if (viewMode === "spoiler")
        return true;
    const a = byId.get(e.f), b = byId.get(e.t);
    return !!(a && b && isNodeVisible(a) && isNodeVisible(b));
}
function maskedNode(n) {
    if (viewMode !== "tracker" || !maskChoiceText)
        return false;
    if (n.id === rootId || n.pic)
        return false;
    if (visitedRevealSet.has(n.id))
        return false;
    return hoveredNodeId !== n.id;
}
const EMOJI_RE = /[\p{Extended_Pictographic}️‍]/gu;
function stripEmoji(s) {
    return s.replace(EMOJI_RE, "");
}
function setHovered(id) {
    if (hoveredNodeId !== id) {
        hoveredNodeId = id;
        draw();
    }
}
function colorFor(n) {
    return n.c || THEME.nodeDefault;
}
function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== "#")
        return `rgba(128,128,128,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
function luminance(hex) {
    if (!hex || hex[0] !== "#")
        return 0.5;
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
}
function wrapLines(text, maxWidth, font) {
    ctx.font = font;
    const out = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(" ")) {
            const test = line ? line + " " + word : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                out.push(line);
                line = word;
            }
            else
                line = test;
        }
        out.push(line);
    }
    return out;
}
function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, cv.width / DPR, cv.height / DPR);
    const vw = cv.width / DPR, vh = cv.height / DPR;
    const [vx0, vy0] = screenToWorld(0, 0), [vx1, vy1] = screenToWorld(vw, vh);
    const active = !!(pathNodes || filterSet);
    // Every node a label could land on, including ones just off-screen (a
    // label can sit partly outside the view while its edge or box is in it).
    const nodeRects = [];
    const reach = 400 / cam.scale;
    for (const n of GRAPH.nodes) {
        if (!isNodeVisible(n))
            continue;
        if (n.x + n.w < vx0 - reach || n.x > vx1 + reach || n.y + n.h < vy0 - reach || n.y > vy1 + reach)
            continue;
        const [nx, ny] = worldToScreen(n.x, n.y);
        nodeRects.push({ x0: nx, y0: ny, x1: nx + n.w * cam.scale, y1: ny + n.h * cam.scale });
    }
    groupLabelRects.length = 0;
    for (const g of viewMode === "spoiler" || showGroups ? GRAPH.groups : []) {
        if (g.x + g.w < vx0 || g.x > vx1 || g.y + g.h < vy0 || g.y > vy1)
            continue;
        const [sx, sy] = worldToScreen(g.x, g.y);
        const sw = g.w * cam.scale, sh = g.h * cam.scale;
        const groupDim = groupOnly && g !== selectedGroup;
        const fillA = groupDim ? 0.02 : isLight ? 0.10 : 0.09;
        const strokeA = groupDim ? 0.15 : 0.55;
        ctx.fillStyle = hexToRgba(g.color, fillA);
        ctx.strokeStyle = hexToRgba(g.color, strokeA);
        ctx.lineWidth = 1.5;
        roundRect(sx, sy, sw, sh, 10);
        ctx.fill();
        ctx.stroke();
        if (cam.scale > 0.12) {
            ctx.globalAlpha = groupDim ? 0.35 : 1;
            ctx.fillStyle = g.color;
            const fontPx = Math.max(10, 12 * Math.min(cam.scale * 1.6, 1));
            ctx.font = `600 ${fontPx}px sans-serif`;
            ctx.textBaseline = "bottom";
            const title = g.label.split("\n")[0];
            const tw = ctx.measureText(title).width;
            // Above the box's top-left corner by default; if that covers a node or
            // another route's title, slide along the top edge (outside, then just
            // inside), then along the bottom edge.
            const spots = [];
            const xsAlong = [];
            for (let ox = 6; ox <= Math.max(6, sw - tw - 6); ox += 18)
                xsAlong.push(sx + ox);
            for (const ty of [sy - 4, sy + fontPx + 6, sy + sh + fontPx + 4, sy + sh - 6]) {
                for (const tx of xsAlong)
                    spots.push([tx, ty]);
            }
            // Beside the box (outside its left/right edge), stepping down it.
            for (let oy = fontPx + 6; oy <= sh; oy += fontPx + 6)
                spots.push([sx - tw - 8, sy + oy], [sx + sw + 8, sy + oy]);
            const fits = ([tx, ty]) => !hitsAny(nodeRects, tx - 2, ty - fontPx - 2, tw + 4, fontPx + 4, 2) &&
                !hitsAny(groupLabelRects, tx - 2, ty - fontPx - 2, tw + 4, fontPx + 4, 2);
            // Nowhere clear (only happens zoomed far out, where rows are packed
            // tighter than the text is tall): leave the title off until zoomed in.
            const spot = spots.find(fits);
            if (spot) {
                const [tx, ty] = spot;
                groupLabelRects.push({ x0: tx - 2, y0: ty - fontPx - 2, x1: tx + tw + 2, y1: ty + 2 });
                ctx.fillText(title, tx, ty);
            }
            ctx.globalAlpha = 1;
        }
    }
    const showEdgeLabels = cam.scale > 0.22 && showConditionPills;
    const labelsToDraw = [];
    for (const e of GRAPH.edges) {
        const a = byId.get(e.f), b = byId.get(e.t);
        if (!a || !b)
            continue;
        if (!isEdgeVisible(e))
            continue;
        const dtx = edgeDetour.get(e.id)?.c ?? a.x;
        if (Math.max(a.x, b.x, dtx) + 400 < vx0 || Math.min(a.x, b.x, dtx) - 400 > vx1)
            continue;
        if (Math.max(a.y + a.h, b.y + b.h) < vy0 || Math.min(a.y, b.y) > vy1)
            continue;
        const inSet = pathEdges && pathEdges.has(e.id);
        const dim = active && !inSet;
        const onPath = inSet && !groupOnly;
        const col = onPath ? THEME.accent : e.c || edgeColor.get(e.id) || THEME.edge;
        ctx.strokeStyle = col;
        ctx.globalAlpha = dim ? 0.1 : onPath ? 1 : e.tree ? 0.85 : 0.6;
        const zw = Math.min(1, cam.scale);
        ctx.lineWidth = (onPath ? 6.2 : e.tree ? 5 : 4.6) * zw;
        ctx.setLineDash(e.tree ? [] : [7, 5]);
        const pts = edgeCurvePoints(e, a, b);
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let o = 2; o < pts.length; o += 6)
            ctx.bezierCurveTo(pts[o], pts[o + 1], pts[o + 2], pts[o + 3], pts[o + 4], pts[o + 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (e.l && showEdgeLabels && !dim) {
            labelsToDraw.push({ e, pts });
        }
        ctx.globalAlpha = 1;
    }
    const showText = cam.scale > 0.16;
    const blockedLabelsToDraw = [];
    for (const n of GRAPH.nodes) {
        if (!isNodeVisible(n))
            continue;
        if (n.x + n.w < vx0 || n.x > vx1 || n.y + n.h < vy0 || n.y > vy1)
            continue;
        const [sx, sy] = worldToScreen(n.x, n.y);
        const sw = n.w * cam.scale, sh = n.h * cam.scale;
        const isMatch = filterSet && filterSet.has(n.id);
        const inSet = pathNodes && pathNodes.has(n.id);
        const dim = active && !isMatch && !inSet;
        const emphasize = (isMatch || inSet) && !groupOnly;
        const isBlocked = viewMode === "tracker" && !!saveState && blockedSet.has(n.id);
        const isObtained = viewMode === "tracker" && !!saveState && n.pic && obtainedSet.has(n.id);
        ctx.globalAlpha = dim ? Number(getComputedStyle(document.documentElement).getPropertyValue("--dim")) : isBlocked ? 0.55 : 1;
        if (n.j) {
            // Junction: just a dot where the incoming lines meet.
            ctx.fillStyle = emphasize ? THEME.accent : THEME.edge;
            ctx.beginPath();
            ctx.arc(sx + sw / 2, sy + sh / 2, Math.max(2, (sw / 2) * 0.7), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            continue;
        }
        const fill = isBlocked ? THEME.edgeDim : colorFor(n);
        ctx.fillStyle = fill;
        ctx.strokeStyle = emphasize ? THEME.accent2 : isBlocked ? THEME.edge : isObtained ? "#3fc98a" : THEME.nodeBorder;
        ctx.lineWidth = emphasize ? 2.6 : isObtained ? 2.2 : 1;
        roundRect(sx, sy, Math.max(sw, 2), Math.max(sh, 2), 6 * cam.scale + 2);
        ctx.fill();
        if (!dim)
            ctx.stroke();
        if (n.isNew && !dim) {
            // New-in-this-update marker: a small gold star badge tucked inside the
            // node's top-right corner. Scales with zoom the same way the node's
            // own text does (no clamping), so it shrinks/grows with the box
            // instead of staying a fixed screen size.
            const starSize = 13 * cam.scale;
            ctx.save();
            ctx.font = `${starSize}px -apple-system,Segoe UI,sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(0,0,0,0.55)";
            ctx.shadowBlur = 2;
            ctx.fillStyle = "#ffcc33";
            ctx.fillText("★", sx + sw - starSize * 0.65, sy + starSize * 0.65);
            ctx.restore();
        }
        if (showText && !dim) {
            const masked = maskedNode(n);
            const lum = luminance(fill.startsWith("#") ? fill : null);
            ctx.fillStyle = fill.startsWith("#") ? (lum > 0.55 ? THEME.textOnColor : "#f2f2f6") : THEME.text;
            if (masked)
                ctx.fillStyle = fill;
            const fontPx = 12 * cam.scale;
            const font = `${fontPx}px -apple-system,Segoe UI,sans-serif`;
            const pad = 6 * cam.scale;
            const lines = wrapLines(masked ? stripEmoji(n.t) : n.t, sw - pad * 2, font);
            ctx.font = font;
            ctx.textAlign = "center";
            const lh = fontPx * 1.25;
            const blockH = lines.length * lh;
            let ty = sy + sh / 2 - blockH / 2 + lh / 2;
            ctx.textBaseline = "middle";
            for (const line of lines) {
                if (ty - lh / 2 > sy + sh)
                    break;
                ctx.fillText(line, sx + sw / 2, ty);
                ty += lh;
            }
            if (isBlocked)
                blockedLabelsToDraw.push({ sx: sx + sw / 2, sy: sy + sh + 4 * cam.scale });
            ctx.textAlign = "left";
        }
        ctx.globalAlpha = 1;
    }
    if (cam.scale > 0.16) {
        ctx.font = `${Math.max(9, 10.5 * cam.scale)}px -apple-system,Segoe UI,sans-serif`;
        ctx.fillStyle = isLight ? "#a1401f" : "#ff9366";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const { sx, sy } of blockedLabelsToDraw)
            ctx.fillText("Disabled due to route chosen", sx, sy);
        ctx.textAlign = "left";
    }
    labelRects.length = 0;
    for (const { e, pts } of labelsToDraw) {
        const onPath = pathEdges && pathEdges.has(e.id) && !groupOnly;
        const fontPx = 15 * Math.min(cam.scale, 1);
        ctx.font = `600 ${fontPx}px -apple-system,Segoe UI,sans-serif`;
        const text = e.l.length > 60 ? e.l.slice(0, 58) + "…" : e.l;
        const tw = ctx.measureText(text).width;
        const padX = 11, padY = 7;
        const rw = tw + padX * 2, rh = fontPx + padY * 2;
        // Find a spot for the pill that covers no node and no label already
        // placed: slide it along its own edge first, then nudge it sideways off
        // the line. Failing that, settle for one that at least clears every
        // node; failing that too, mid-edge.
        const [mx, my] = placeLabel(pts, rw, rh, nodeRects.concat(groupLabelRects));
        const rx = mx - rw / 2, ry = my - rh / 2;
        ctx.fillStyle = THEME.panel;
        ctx.strokeStyle = onPath ? THEME.accent : THEME.panelBorder;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.97;
        roundRect(rx, ry, rw, rh, 7);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = THEME.accent2;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, mx, my + 1);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
        labelRects.push({ e, x0: rx, y0: ry, x1: rx + rw, y1: ry + rh });
    }
    drawMinimap();
}
/** Positions along an edge (0 = source, 1 = target) tried in turn for its
 *  label: mid-edge first, then outward in small steps -- fine enough that a
 *  long edge running down past a column of nodes still finds the gaps
 *  between their rows. */
const LABEL_SLOTS = [0.5, ...Array.from({ length: 11 }, (_, k) => [0.5 + 0.04 * (k + 1), 0.5 - 0.04 * (k + 1)]).flat()];
function hitsAny(rects, x0, y0, w, h, margin) {
    return rects.some((r) => x0 < r.x1 + margin && x0 + w > r.x0 - margin && y0 < r.y1 + margin && y0 + h > r.y0 - margin);
}
function placeLabel(pts, rw, rh, nodeRects) {
    // Sideways nudges, in units of the pill's own width: on the line first,
    // then just beside it, then further out.
    const shifts = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
    let nodeClear = null;
    for (const s of shifts) {
        for (const t of LABEL_SLOTS) {
            const [px, py] = pathPoint(pts, t);
            const mx = px + s * rw, my = py;
            const x0 = mx - rw / 2, y0 = my - rh / 2;
            if (hitsAny(nodeRects, x0, y0, rw, rh, 4))
                continue;
            if (!hitsAny(labelRects, x0, y0, rw, rh, 3))
                return [mx, my];
            nodeClear ?? (nodeClear = [mx, my]);
        }
    }
    return nodeClear ?? pathPoint(pts, 0.5);
}
function edgeArrivalOffset(e, b) {
    // A dashed reconvergence edge, by definition, always shares its target
    // with at least one other (tree) edge -- every non-par edge arrives at
    // the exact same top-center point with the exact same straight-down
    // tangent (see below), so when a node has more than one, their curves
    // land on top of each other and become indistinguishable.
    // Fan converging edges out across the node's top edge instead, so each
    // stays visually distinct.
    if (b.j)
        return 0; // lines converge on the junction dot itself
    const siblings = (inEdges.get(e.t) ?? []).filter((x) => !x.par);
    if (siblings.length <= 1)
        return 0;
    const idx = siblings.indexOf(e);
    const frac = (idx + 1) / (siblings.length + 1) - 0.5;
    return frac * Math.min(b.w * 0.6, 120);
}
function edgeCurvePoints(e, a, b) {
    const p = edgeWorldPoints(e, a, b, cam.scale);
    const out = [];
    for (let i = 0; i < p.length; i += 2)
        out.push(...worldToScreen(p[i], p[i + 1]));
    return out;
}
/** An edge's path in world coordinates, as joined cubic segments. `scale`
 *  only matters for the minimum bend (40 screen px) of a normal edge. */
function edgeWorldPoints(e, a, b, scale) {
    if (e.par) {
        const x0 = a.x + a.w, y0 = a.y + a.h / 2, x3 = b.x, y3 = b.y + b.h / 2;
        const midX = (x0 + x3) / 2;
        return [x0, y0, midX, y0, midX, y3, x3, y3];
    }
    const offset = edgeArrivalOffset(e, b);
    const x0 = a.x + a.w / 2, y0 = a.y + a.h, x3 = b.x + b.w / 2 + offset, y3 = b.y;
    const detour = edgeDetour.get(e.id);
    if (detour !== undefined)
        return detourPoints(x0, y0, x3, y3, detour);
    // Control points pull symmetrically away from BOTH ends -- P1 sits `dy`
    // below the source, P2 sits `dy` above the target -- rather than both
    // sharing one shared midpoint. That guarantees the curve always LEAVES
    // downward and always ARRIVES downward regardless of whether the target
    // is actually below the source (a reconvergence edge between same-row
    // siblings can have the source's bottom sitting at or below the target's
    // top, where a single shared midpoint either flips the arrival tangent
    // backward, or -- for a small-but-normal gap -- pulls the curve into a
    // cramped, ugly loop. The `/2` matches the plain midpoint exactly whenever the gap is already
    // >= 80px, so ordinary edges render pixel-identical to before; only
    // small or inverted gaps get the wider, smoother pull.
    const dy = Math.max(40 / scale, Math.abs(y3 - y0) / 2);
    return [x0, y0, x0, y0 + dy, x3, y3 - dy, x3, y3];
}
function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function drawMinimap() {
    if (mm.style.display === "none")
        return;
    const w = mm.width, h = mm.height;
    mmCtx.fillStyle = THEME.mmBg;
    mmCtx.fillRect(0, 0, w, h);
    const wW = worldMaxX - worldMinX, wH = worldMaxY - worldMinY;
    const s = Math.min((w - 12) / wW, (h - 12) / wH);
    // The graph's aspect ratio rarely matches the minimap box's (this tree is
    // usually much taller than wide), so whichever axis isn't the binding
    // constraint in `s` has leftover space -- center the content in it
    // instead of anchoring flush to the top-left with a fixed 6px margin,
    // which left a tall/narrow tree pinned to the left edge of a wider box.
    const ox = (w - wW * s) / 2 - worldMinX * s, oy = (h - wH * s) / 2 - worldMinY * s;
    mmCtx.fillStyle = THEME.mmDot;
    for (const n of GRAPH.nodes) {
        if (!isNodeVisible(n))
            continue;
        mmCtx.fillRect(n.x * s + ox, n.y * s + oy, Math.max(1, n.w * s), Math.max(1, n.h * s));
    }
    if (pathNodes) {
        mmCtx.fillStyle = THEME.accent2;
        for (const id of pathNodes) {
            const n = byId.get(id);
            if (!n)
                continue;
            mmCtx.fillRect(n.x * s + ox, n.y * s + oy, Math.max(1.5, n.w * s), Math.max(1.5, n.h * s));
        }
    }
    const [vx0, vy0] = screenToWorld(0, 0), [vx1, vy1] = screenToWorld(cv.width / DPR, cv.height / DPR);
    mmCtx.strokeStyle = THEME.accent;
    mmCtx.lineWidth = 1.5;
    mmCtx.strokeRect(vx0 * s + ox, vy0 * s + oy, (vx1 - vx0) * s, (vy1 - vy0) * s);
}
let dragging = false, dragMoved = false, lastPx = 0, lastPy = 0;
cv.addEventListener("mousedown", (e) => {
    dragging = true;
    dragMoved = false;
    lastPx = e.clientX;
    lastPy = e.clientY;
});
window.addEventListener("mousemove", (e) => {
    if (dragging) {
        const dx = e.clientX - lastPx, dy = e.clientY - lastPy;
        if (Math.abs(dx) + Math.abs(dy) > 3)
            dragMoved = true;
        cam.x -= dx / cam.scale;
        cam.y -= dy / cam.scale;
        lastPx = e.clientX;
        lastPy = e.clientY;
        setHovered(null);
        draw();
        tooltip.style.display = "none";
    }
    else if (e.target === cv) {
        handleHover(e);
    }
    else {
        setHovered(null);
        tooltip.style.display = "none";
    }
});
window.addEventListener("mouseup", (e) => {
    if (dragging && !dragMoved)
        handleClick(e);
    dragging = false;
});
cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    const factor = Math.pow(1.0015, -e.deltaY);
    cam.scale = Math.min(4, Math.max(0.01, cam.scale * factor));
    const [nx, ny] = screenToWorld(e.clientX, e.clientY);
    cam.x += wx - nx;
    cam.y += wy - ny;
    draw();
}, { passive: false });
function nodeAt(clientX, clientY) {
    const [wx, wy] = screenToWorld(clientX, clientY);
    for (let i = GRAPH.nodes.length - 1; i >= 0; i--) {
        const n = GRAPH.nodes[i];
        if (!isNodeVisible(n) || n.j)
            continue;
        if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h)
            return n;
    }
    return null;
}
function bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, t) {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3];
}
function pointToSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function pillAt(clientX, clientY) {
    for (let i = labelRects.length - 1; i >= 0; i--) {
        const r = labelRects[i];
        if (clientX >= r.x0 && clientX <= r.x1 && clientY >= r.y0 && clientY <= r.y1)
            return r.e;
    }
    return null;
}
function edgeAt(clientX, clientY) {
    const TOL = 9;
    let best = null, bestDist = TOL;
    for (const e of GRAPH.edges) {
        const a = byId.get(e.f), b = byId.get(e.t);
        if (!a || !b)
            continue;
        if (!isEdgeVisible(e))
            continue;
        const pts = edgeCurvePoints(e, a, b);
        const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
        if (clientX < Math.min(...xs) - TOL || clientX > Math.max(...xs) + TOL)
            continue;
        if (clientY < Math.min(...ys) - TOL || clientY > Math.max(...ys) + TOL)
            continue;
        const steps = 16 * ((pts.length - 2) / 6);
        let prev = [pts[0], pts[1]];
        for (let i = 1; i <= steps; i++) {
            const pt = pathPoint(pts, i / steps);
            const d = pointToSegDist(clientX, clientY, prev[0], prev[1], pt[0], pt[1]);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
            prev = pt;
        }
    }
    return best;
}
function selectEdge(e, animate = true) {
    const a = byId.get(e.f), b = byId.get(e.t);
    if (!a || !b)
        return;
    pathNodes = new Set([e.f, e.t]);
    pathEdges = new Set([e.id]);
    filterSet = null;
    groupOnly = false;
    selectedGroup = null;
    getEl("results").style.display = "none";
    getEl("clearBtn").style.display = "inline-block";
    const cx = (a.x + a.w / 2 + b.x + b.w / 2) / 2, cy = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
    centerOn(cx, cy, Math.max(cam.scale, 0.85), animate);
}
function groupAt(clientX, clientY) {
    if (viewMode !== "spoiler" && !(viewMode === "tracker" && showGroups))
        return null;
    const [wx, wy] = screenToWorld(clientX, clientY);
    let best = null, bestArea = Infinity;
    for (const g of GRAPH.groups) {
        if (wx < g.x || wx > g.x + g.w || wy < g.y || wy > g.y + g.h)
            continue;
        const area = g.w * g.h;
        if (area < bestArea) {
            bestArea = area;
            best = g;
        }
    }
    return best;
}
function selectGroup(g, animate = true) {
    const members = new Set(g.members ?? []);
    pathNodes = members;
    const es = new Set();
    for (const e of GRAPH.edges)
        if (members.has(e.f) && members.has(e.t))
            es.add(e.id);
    pathEdges = es;
    filterSet = null;
    groupOnly = true;
    selectedGroup = g;
    getEl("results").style.display = "none";
    getEl("clearBtn").style.display = "inline-block";
    const vw = cv.width / DPR - 100, vh = cv.height / DPR - 100;
    const s = Math.min(vw / g.w, vh / g.h, 1.2);
    centerOn(g.x + g.w / 2, g.y + g.h / 2, Math.max(0.02, s), animate);
}
function selectGroupTracker(g, animate = true) {
    groupOnly = true;
    selectedGroup = g;
    pathNodes = null;
    pathEdges = null;
    filterSet = null;
    getEl("results").style.display = "none";
    getEl("clearBtn").style.display = "inline-block";
    const vw = cv.width / DPR - 100, vh = cv.height / DPR - 100;
    const s = Math.min(vw / g.w, vh / g.h, 1.2);
    centerOn(g.x + g.w / 2, g.y + g.h / 2, Math.max(0.02, s), animate);
}
function handleClick(e) {
    const pill = pillAt(e.clientX, e.clientY);
    if (pill) {
        selectEdge(pill);
        return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    if (n) {
        selectNode(n.id);
        return;
    }
    const edge = edgeAt(e.clientX, e.clientY);
    if (edge) {
        selectEdge(edge);
        return;
    }
    const g = groupAt(e.clientX, e.clientY);
    if (g) {
        (viewMode === "tracker" ? selectGroupTracker : selectGroup)(g);
        return;
    }
    if (pathNodes || filterSet || groupOnly)
        clearHighlight();
}
function handleHover(e) {
    const pill = pillAt(e.clientX, e.clientY);
    if (pill) {
        setHovered(null);
        const a = byId.get(pill.f), b = byId.get(pill.t);
        let html = `<b>${escapeHtml(a.t.split("\n")[0])}</b> &rarr; <b>${escapeHtml(b.t.split("\n")[0])}</b>`;
        if (pill.l)
            html += `<div class="cond">${escapeHtml(pill.l)}</div>`;
        showTooltip(html, e.clientX, e.clientY);
        cv.style.cursor = "pointer";
        return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    if (n) {
        setHovered(n.id);
        let html = `<b>${escapeHtml(n.t)}</b>`;
        if (showConditionPills && n.note)
            html += `<div class="cond">${escapeHtml(n.note)}</div>`;
        if (viewMode === "tracker" && saveState && blockedSet.has(n.id)) {
            html += `<div class="blocked">Disabled due to route chosen</div>`;
        }
        else if (viewMode === "tracker" && saveState && n.pic && obtainedSet.has(n.id)) {
            html += `<div class="obtained">Already unlocked</div>`;
        }
        const day = nearestDayLabel(n.y);
        if (day)
            html += `<div class="muted">${escapeHtml(day)}</div>`;
        if (showConditionPills) {
            const outs = outEdges.get(n.id) ?? [];
            const labeled = outs.filter((o) => o.l);
            for (const o of labeled.slice(0, 4))
                html += `<div class="cond">&rarr; ${escapeHtml(o.l)}</div>`;
            const upstream = ancestorConditions(n.id);
            if (upstream.length) {
                html += `<div class="muted" style="margin-top:6px">Along the way to get here:</div>`;
                for (const l of upstream.slice(0, 6))
                    html += `<div class="cond">${escapeHtml(l)}</div>`;
                if (upstream.length > 6)
                    html += `<div class="muted">+${upstream.length - 6} more</div>`;
            }
        }
        showTooltip(html, e.clientX, e.clientY);
        cv.style.cursor = "pointer";
        return;
    }
    const edge = edgeAt(e.clientX, e.clientY);
    if (edge) {
        setHovered(null);
        const a = byId.get(edge.f), b = byId.get(edge.t);
        let html = `<b>${escapeHtml(a.t.split("\n")[0])}</b> &rarr; <b>${escapeHtml(b.t.split("\n")[0])}</b>`;
        if (showConditionPills && edge.l)
            html += `<div class="cond">${escapeHtml(edge.l)}</div>`;
        showTooltip(html, e.clientX, e.clientY);
        cv.style.cursor = "pointer";
        return;
    }
    const g = groupAt(e.clientX, e.clientY);
    if (g) {
        setHovered(null);
        const count = (g.members ?? []).length;
        showTooltip(`<b>${escapeHtml(g.label.split("\n")[0])}</b><div class="muted">${count} node${count === 1 ? "" : "s"}</div>`, e.clientX, e.clientY);
        cv.style.cursor = "pointer";
        return;
    }
    setHovered(null);
    tooltip.style.display = "none";
    cv.style.cursor = "default";
}
function showTooltip(html, clientX, clientY) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    const tw = 340;
    let tx = clientX + 16, ty = clientY + 12;
    if (tx + tw > innerWidth)
        tx = clientX - tw - 16;
    if (ty + 140 > innerHeight)
        ty = innerHeight - 150;
    tooltip.style.left = tx + "px";
    tooltip.style.top = ty + "px";
}
function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function minimapToWorld(clientX, clientY) {
    const rect = mm.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const wW = worldMaxX - worldMinX, wH = worldMaxY - worldMinY;
    const s = Math.min((mm.width - 12) / wW, (mm.height - 12) / wH);
    // Must match drawMinimap()'s centering exactly, or a click lands on a
    // different node than the one visually under the cursor.
    const ox = (mm.width - wW * s) / 2 - worldMinX * s, oy = (mm.height - wH * s) / 2 - worldMinY * s;
    return [(mx - ox) / s, (my - oy) / s];
}
mm.addEventListener("mousedown", (e) => {
    const [wx, wy] = minimapToWorld(e.clientX, e.clientY);
    centerOn(wx, wy, cam.scale, false);
    e.stopPropagation();
});
mm.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [wx, wy] = minimapToWorld(e.clientX, e.clientY);
    const factor = Math.pow(1.0015, -e.deltaY);
    cam.scale = Math.min(4, Math.max(0.01, cam.scale * factor));
    centerOn(wx, wy, cam.scale, false);
}, { passive: false });
const searchInput = getEl("searchInput");
const resultsEl = getEl("results");
const matchCountEl = getEl("matchCount");
const clearBtn = getEl("clearBtn");
function runSearch(qRaw) {
    const q = qRaw.trim().toLowerCase();
    if (!q) {
        filterSet = null;
        pathNodes = null;
        pathEdges = null;
        groupOnly = false;
        selectedGroup = null;
        resultsEl.style.display = "none";
        matchCountEl.textContent = "";
        clearBtn.style.display = "none";
        draw();
        return;
    }
    clearBtn.style.display = "inline-block";
    const matches = [];
    const pool = viewMode === "tracker" ? pictureNodes : GRAPH.nodes;
    // "new" also finds the starred nodes new in this update.
    const wantNew = q === "new";
    for (const n of pool) {
        if (n.t.toLowerCase().includes(q) || (wantNew && n.isNew))
            matches.push(n);
    }
    if (wantNew)
        matches.sort((a, b) => Number(!!b.isNew) - Number(!!a.isNew));
    filterSet = new Set(matches.map((n) => n.id));
    pathNodes = null;
    pathEdges = null;
    groupOnly = false;
    selectedGroup = null;
    matchCountEl.textContent = matches.length + (matches.length === 1 ? " match" : " matches");
    resultsEl.innerHTML = "";
    if (matches.length) {
        resultsEl.style.display = "block";
        for (const n of matches.slice(0, 60)) {
            const div = document.createElement("div");
            div.className = "result";
            const day = nearestDayLabel(n.y);
            const star = n.isNew ? `<span class="newStar" title="New in this update">★</span>` : "";
            div.innerHTML = `<span class="lbl">${star}${escapeHtml(n.t.split("\n")[0])}</span><span class="ctx">${escapeHtml(day)}</span>`;
            div.addEventListener("mousedown", (ev) => { ev.stopPropagation(); selectNode(n.id); });
            resultsEl.appendChild(div);
        }
        if (matches.length > 60) {
            const div = document.createElement("div");
            div.className = "result more";
            div.textContent = `+ ${matches.length - 60} more (refine search)`;
            resultsEl.appendChild(div);
        }
    }
    else {
        resultsEl.style.display = "none";
    }
    draw();
}
searchInput.addEventListener("input", () => runSearch(searchInput.value));
searchInput.addEventListener("focus", () => { if (filterSet)
    resultsEl.style.display = "block"; });
document.addEventListener("mousedown", (e) => {
    if (!getEl("searchWrap").contains(e.target))
        resultsEl.style.display = "none";
});
clearBtn.addEventListener("click", clearHighlight);
const routeSelect = getEl("routeSelect");
function buildRouteOptions() {
    routeSelect.innerHTML = "";
    const blank = document.createElement("option");
    blank.textContent = "Jump to…";
    blank.value = "";
    routeSelect.appendChild(blank);
    if (viewMode === "tracker") {
        const grp = document.createElement("optgroup");
        grp.label = "Pictures";
        pictureNodes.forEach((n) => {
            const opt = document.createElement("option");
            opt.value = "n:" + n.id;
            opt.textContent = n.t.split("\n")[0];
            grp.appendChild(opt);
        });
        routeSelect.appendChild(grp);
    }
    else {
        const dayOpts = document.createElement("optgroup");
        dayOpts.label = "Days";
        const routeOpts = document.createElement("optgroup");
        routeOpts.label = "Route branches";
        GRAPH.routes.forEach((r, i) => {
            const opt = document.createElement("option");
            opt.value = "r:" + i;
            opt.textContent = r.label.split("\n")[0];
            (r.kind === "day" ? dayOpts : routeOpts).appendChild(opt);
        });
        routeSelect.appendChild(dayOpts);
        routeSelect.appendChild(routeOpts);
    }
}
routeSelect.addEventListener("change", () => {
    if (!routeSelect.value)
        return;
    const [kind, val] = routeSelect.value.split(":");
    if (kind === "r") {
        const r = GRAPH.routes[+val];
        centerOn(r.x, r.y + 60, Math.max(cam.scale, 0.55));
    }
    else {
        selectNode(val);
    }
    routeSelect.value = "";
});
buildRouteOptions();
const legendEl = getEl("legend");
const legendBtn = getEl("legendBtn");
function buildLegend() {
    let html = "<h4>Characters</h4>";
    for (const [name, hex] of Object.entries(CHAR_LEGEND.chars)) {
        html += `<div class="legend-row"><span class="swatch" style="background:${hex}"></span>${name}</div>`;
    }
    html += "<h4>Other</h4>";
    html += `<div class="legend-row"><span class="swatch" style="background:${CHAR_LEGEND.day}"></span>Day header</div>`;
    html += `<div class="legend-row"><span class="swatch" style="background:${CHAR_LEGEND.leak}"></span>Leaked content</div>`;
    html += `<div class="legend-row"><span class="swatch" style="background:${THEME.nodeDefault};border-color:${THEME.nodeBorder}"></span>Narration / choice</div>`;
    html += "<h4>Edges</h4>";
    html += `<div class="legend-row">&#8212; solid: main branch (tree)</div>`;
    html += `<div class="legend-row">&#8211;&#8211; dashed: reconverges here too</div>`;
    html += `<div class="legend-row condition">condition text: shown on the edge</div>`;
    html += "<h4>Route groups</h4>";
    html += `<div class="legend-row">tinted by the character they belong to; click a group to bring its nodes forward</div>`;
    html += "<h4>Tracker Mode (with a save loaded)</h4>";
    html += `<div class="legend-row"><span class="swatch" style="background:none;border-color:#3fc98a;border-width:2px"></span>already unlocked</div>`;
    html += `<div class="legend-row"><span class="swatch" style="background:${THEME.edgeDim};border-color:${THEME.edge}"></span>disabled due to route chosen</div>`;
    legendEl.innerHTML = html;
}
legendEl.style.display = "block";
legendBtn.classList.add("active");
legendBtn.addEventListener("click", () => {
    const showing = legendEl.style.display === "block";
    legendEl.style.display = showing ? "none" : "block";
    legendBtn.classList.toggle("active", !showing);
});
const minimapBtn = getEl("minimapBtn");
minimapBtn.classList.add("active");
minimapBtn.addEventListener("click", () => {
    const showing = mm.style.display !== "none";
    mm.style.display = showing ? "none" : "block";
    minimapBtn.classList.toggle("active", !showing);
});
getEl("fitBtn").addEventListener("click", () => fitAll(true));
const spoilerModal = getEl("spoilerModal");
function spoilerAcked() {
    try {
        return localStorage.getItem("ntrsim-spoiler-ack") === "1";
    }
    catch {
        return false;
    }
}
function confirmSpoilerMode(onConfirmed) {
    if (spoilerAcked()) {
        onConfirmed();
        return;
    }
    spoilerModal.classList.add("showing");
    getEl("spoilerContinue").onclick = () => {
        if (getEl("spoilerAckCheck").checked) {
            try {
                localStorage.setItem("ntrsim-spoiler-ack", "1");
            }
            catch { }
        }
        spoilerModal.classList.remove("showing");
        onConfirmed();
    };
    getEl("spoilerBack").onclick = () => {
        spoilerModal.classList.remove("showing");
        try {
            localStorage.setItem("ntrsim-view-mode", "tracker");
        }
        catch { }
        applyMode("tracker");
    };
}
const trackerModeBtn = getEl("trackerModeBtn");
const spoilerModeBtn = getEl("spoilerModeBtn");
const saveWrap = getEl("saveWrap");
const saveStatus = getEl("saveStatus");
const saveUploadBtn = getEl("saveUploadBtn");
const saveClearBtn = getEl("saveClearBtn");
const saveFileInput = getEl("saveFileInput");
const optionsWrap = getEl("optionsWrap");
const optionsBtn = getEl("optionsBtn");
const optionsPanel = getEl("optionsPanel");
const optMaskText = getEl("optMaskText");
const optShowConditions = getEl("optShowConditions");
const optStrictPath = getEl("optStrictPath");
const optShowGroups = getEl("optShowGroups");
const optTrackerOnlyRows = document.querySelectorAll(".optTrackerOnly");
function pillsKeyFor(mode) {
    return mode === "tracker" ? "ntrsim-show-pills-tracker" : "ntrsim-show-pills-spoiler";
}
function loadPillsForMode(mode) {
    let stored = null;
    try {
        stored = localStorage.getItem(pillsKeyFor(mode));
    }
    catch { }
    if (stored === null) {
        try {
            stored = localStorage.getItem("ntrsim-show-pills");
        }
        catch { }
    }
    return stored === "1";
}
function applyPillsToggle(show) {
    showConditionPills = show;
    optShowConditions.checked = show;
    draw();
}
function applyMaskToggle(mask) {
    maskChoiceText = mask;
    optMaskText.checked = mask;
    draw();
}
function applyGroupsToggle(show) {
    showGroups = show;
    optShowGroups.checked = show;
    draw();
}
optShowConditions.addEventListener("change", () => {
    const next = optShowConditions.checked;
    try {
        localStorage.setItem(pillsKeyFor(viewMode), next ? "1" : "0");
    }
    catch { }
    applyPillsToggle(next);
});
optMaskText.addEventListener("change", () => {
    const next = optMaskText.checked;
    try {
        localStorage.setItem("ntrsim-mask-text", next ? "1" : "0");
    }
    catch { }
    applyMaskToggle(next);
});
optStrictPath.addEventListener("change", () => {
    const next = optStrictPath.checked;
    try {
        localStorage.setItem("ntrsim-strict-path", next ? "1" : "0");
    }
    catch { }
    applyStrictPathToggle(next);
});
optShowGroups.addEventListener("change", () => {
    const next = optShowGroups.checked;
    try {
        localStorage.setItem("ntrsim-show-groups", next ? "1" : "0");
    }
    catch { }
    applyGroupsToggle(next);
});
optionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const showing = optionsPanel.classList.toggle("showing");
    optionsBtn.classList.toggle("active", showing);
});
document.addEventListener("mousedown", (e) => {
    if (!optionsWrap.contains(e.target)) {
        optionsPanel.classList.remove("showing");
        optionsBtn.classList.remove("active");
    }
});
function updateSaveStatus() {
    if (!saveState) {
        saveStatus.textContent = "No save loaded";
        saveClearBtn.style.display = "none";
        return;
    }
    const day = saveState.currentDay != null ? `Day ${saveState.currentDay}` : saveState.activeEventId || "unknown point";
    saveStatus.textContent = `Save: ${day}`;
    saveStatus.title = [
        saveState.slotName && `Slot: ${saveState.slotName}`,
        saveState.saveTime && `Saved: ${saveState.saveTime}`,
        saveState.gameVersion && `Game v${saveState.gameVersion}`,
    ].filter(Boolean).join("\n");
    saveClearBtn.style.display = "inline-block";
}
function applySave(rawSave) {
    saveState = rawSave;
    blockedSet = computeBlocked(rawSave);
    visitedRevealSet = computeVisited(rawSave, !strictPathOnly);
    obtainedSet = computeObtained(rawSave);
    updateSaveStatus();
    buildFlagsPanel();
    draw();
}
function clearSave() {
    saveState = null;
    blockedSet = new Set();
    visitedRevealSet = new Set();
    obtainedSet = new Set();
    try {
        localStorage.removeItem("ntrsim-save-state");
    }
    catch { }
    updateSaveStatus();
    buildFlagsPanel();
    draw();
}
// ---------- Flag tracker (tracker mode, save loaded) ----------
// Lists the Story flags the loaded save has set: route flags (ones some
// event's eligibility depends on) first, then the rest, each with the day
// it's set on and, where the save's own history shows where, a jump there.
const flagsBtn = getEl("flagsBtn");
const flagsPanel = getEl("flagsPanel");
const ROUTE_FLAGS = new Set(GRAPH.route_flags ?? []);
function flagDisplayName(flag) {
    return GRAPH.flag_names?.[flag] ?? flag;
}
function flagDay(flag) {
    const m = (GRAPH.flag_events[flag] ?? "").match(/^(\d+)/);
    return m ? Number(m[1]) : null;
}
/** The node where this save set `flag`: one its own chat history visited
 *  that announces "<flag> Flag Triggered" (on the node, or on the line into
 *  it). Only visited ones, so this never reveals a choice the save didn't
 *  make. */
function flagSourceNode(flag) {
    const needle = `${flagDisplayName(flag)} Flag Triggered`;
    for (const n of GRAPH.nodes)
        if (n.t.includes(needle) && visitedRevealSet.has(n.id))
            return n.id;
    for (const e of GRAPH.edges)
        if (e.l && e.l.includes(needle) && visitedRevealSet.has(e.t))
            return e.t;
    return null;
}
function buildFlagsPanel() {
    flagsBtn.style.display = saveState ? "inline-block" : "none";
    if (!saveState) {
        hideFlagsPanel();
        return;
    }
    const flags = saveState.flags.slice().sort((a, b) => (flagDay(a) ?? 999) - (flagDay(b) ?? 999) || a.localeCompare(b));
    flagsBtn.textContent = `Flags (${flags.length})`;
    flagsPanel.textContent = "";
    const sections = [
        ["Route flags", flags.filter((f) => ROUTE_FLAGS.has(f))],
        ["Other flags", flags.filter((f) => !ROUTE_FLAGS.has(f))],
    ];
    if (!flags.length) {
        const p = document.createElement("p");
        p.className = "flagsEmpty";
        p.textContent = "This save hasn't set any flags yet.";
        flagsPanel.appendChild(p);
    }
    for (const [title, list] of sections) {
        if (!list.length)
            continue;
        const h = document.createElement("h4");
        h.textContent = title;
        flagsPanel.appendChild(h);
        const ul = document.createElement("ul");
        for (const flag of list) {
            const li = document.createElement("li");
            const src = flagSourceNode(flag);
            const row = document.createElement(src ? "button" : "div");
            row.className = "flagRow";
            const name = document.createElement("span");
            name.className = "flagName";
            name.textContent = flagDisplayName(flag);
            const day = document.createElement("span");
            day.className = "flagDay";
            const d = flagDay(flag);
            day.textContent = d != null ? `Day ${d}` : "";
            row.append(name, day);
            if (src) {
                row.type = "button";
                row.title = "Show where this was set";
                row.addEventListener("click", () => { hideFlagsPanel(); selectNode(src); });
            }
            li.appendChild(row);
            ul.appendChild(li);
        }
        flagsPanel.appendChild(ul);
    }
}
function hideFlagsPanel() {
    flagsPanel.classList.remove("showing");
    flagsBtn.classList.remove("active");
    flagsBtn.setAttribute("aria-expanded", "false");
}
flagsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const showing = flagsPanel.classList.toggle("showing");
    flagsBtn.classList.toggle("active", showing);
    flagsBtn.setAttribute("aria-expanded", String(showing));
});
document.addEventListener("mousedown", (e) => {
    if (!flagsPanel.contains(e.target) && e.target !== flagsBtn)
        hideFlagsPanel();
});
function applyStrictPathToggle(strict) {
    strictPathOnly = strict;
    optStrictPath.checked = strict;
    if (saveState)
        visitedRevealSet = computeVisited(saveState, !strictPathOnly);
    buildFlagsPanel();
    draw();
}
saveUploadBtn.addEventListener("click", () => saveFileInput.click());
saveFileInput.addEventListener("change", async () => {
    const file = saveFileInput.files?.[0];
    if (!file)
        return;
    try {
        const text = await file.text();
        const raw = JSON.parse(text);
        const normalized = normalizeSave(raw);
        try {
            localStorage.setItem("ntrsim-save-state", JSON.stringify(normalized));
        }
        catch { }
        applySave(normalized);
    }
    catch {
        saveStatus.textContent = "Could not read that save file";
    }
    saveFileInput.value = "";
});
saveClearBtn.addEventListener("click", clearSave);
function loadPersistedSave() {
    let stored = null;
    try {
        stored = localStorage.getItem("ntrsim-save-state");
    }
    catch { }
    if (!stored)
        return;
    try {
        applySave(JSON.parse(stored));
    }
    catch { }
}
function applyMode(mode) {
    viewMode = mode;
    trackerModeBtn.classList.toggle("active", mode === "tracker");
    spoilerModeBtn.classList.toggle("active", mode === "spoiler");
    saveWrap.style.display = mode === "tracker" ? "flex" : "none";
    for (const row of optTrackerOnlyRows)
        row.style.display = mode === "tracker" ? "" : "none";
    optionsPanel.classList.remove("showing");
    optionsBtn.classList.remove("active");
    hideFlagsPanel();
    applyPillsToggle(loadPillsForMode(mode));
    clearHighlight();
    buildRouteOptions();
    draw();
}
function currentViewMode() {
    let stored = null;
    try {
        stored = localStorage.getItem("ntrsim-view-mode");
    }
    catch { }
    return stored === "tracker" || stored === "spoiler" ? stored : "tracker";
}
trackerModeBtn.addEventListener("click", () => {
    try {
        localStorage.setItem("ntrsim-view-mode", "tracker");
    }
    catch { }
    applyMode("tracker");
});
spoilerModeBtn.addEventListener("click", () => {
    confirmSpoilerMode(() => {
        try {
            localStorage.setItem("ntrsim-view-mode", "spoiler");
        }
        catch { }
        applyMode("spoiler");
    });
});
getEl("themeBtn").addEventListener("click", () => {
    const next = isLight ? "dark" : "light";
    try {
        localStorage.setItem("ntrsim-theme", next);
    }
    catch { }
    applyTheme(next);
});
const welcomeModal = getEl("welcomeModal");
function welcomeAcked() {
    try {
        return localStorage.getItem("ntrsim-welcome-ack") === "1";
    }
    catch {
        return false;
    }
}
function showWelcomeModal() {
    welcomeModal.classList.add("showing");
}
function hideWelcomeModal() {
    if (getEl("welcomeAckCheck").checked) {
        try {
            localStorage.setItem("ntrsim-welcome-ack", "1");
        }
        catch { }
    }
    welcomeModal.classList.remove("showing");
}
getEl("welcomeSkip").addEventListener("click", () => { hideWelcomeModal(); showPendingChangelog(); });
getEl("welcomeTour").addEventListener("click", () => { hideWelcomeModal(); startTour(); });
getEl("aboutBtn").addEventListener("click", showWelcomeModal);
const changelogModal = getEl("changelogModal");
function showChangelog() {
    changelogModal.classList.add("showing");
    try {
        localStorage.setItem(CHANGELOG_SEEN_KEY, LATEST_CHANGELOG);
    }
    catch { }
}
getEl("changelogBtn").addEventListener("click", showChangelog);
getEl("changelogClose").addEventListener("click", () => changelogModal.classList.remove("showing"));
/** Newest changelog entry's heading (its date) -- the "version" a visitor
 *  has seen. A returning visitor whose last-seen entry is older gets the
 *  changelog once, right after the About box (or the tour) is closed. */
const CHANGELOG_SEEN_KEY = "ntrsim-changelog-seen";
const LATEST_CHANGELOG = document.querySelector("#changelogList .changelogEntry h3")?.textContent?.trim() ?? "";
let changelogPending = (() => {
    let seen = null, returning = false;
    try {
        seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
        // Visitors from before this was tracked have no record yet, but any
        // other saved explorer setting means they've been here before.
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("ntrsim-") && k !== CHANGELOG_SEEN_KEY) {
                returning = true;
                break;
            }
        }
        if (seen === null && !returning)
            localStorage.setItem(CHANGELOG_SEEN_KEY, LATEST_CHANGELOG);
    }
    catch {
        return false;
    }
    if (!LATEST_CHANGELOG)
        return false;
    return seen === null ? returning : seen !== LATEST_CHANGELOG;
})();
function showPendingChangelog() {
    if (!changelogPending)
        return;
    changelogPending = false;
    showChangelog();
}
const TOUR_STEPS = [
    { sel: "#trackerModeBtn", title: "Tracker Mode", text: "The default view. It shows every unlock, but hides the nodes and decisions behind them until you’ve actually reached them. Click an unlock to reveal every node on the path that reaches it." },
    { sel: "#spoilerModeBtn", title: "All Routes/Options", text: "Shows the entire map at once, with nothing hidden. Every route, choice, and unlock is visible, including ones you haven’t reached yet. Switching here shows a one-time spoiler warning first." },
    { sel: "#saveWrap", title: "Upload your save", text: "Upload a .ntrsave file to mark what you’ve already unlocked, grey out anything your current route rules out, and reveal the choices your save actually made." },
    { sel: "#optionsWrap", title: "Options", text: "Fine-tune Tracker Mode: hide choice text until you hover it, show the raw unlock conditions, show only your save’s exact path, or draw the route-group backdrop." },
    { sel: "#searchWrap", title: "Search", text: "Search by name to jump straight to a picture (or, in All Routes mode, any node)." },
    { sel: "#routeWrap", title: "Jump to", text: "Jump the camera straight to a specific day, route branch, or picture." },
    { sel: "#fitBtn", title: "Fit All", text: "Zoom out to see the whole visible graph at once." },
    { sel: "#legendBtn", title: "Legend", text: "Shows what each color and line style on the map means." },
    { sel: "#minimapBtn", title: "Minimap", text: "A small overview map in the corner. Click it to jump around, or toggle it off." },
    { sel: "#themeBtn", title: "Theme", text: "Switch between light and dark." },
    { sel: "#changelogBtn", title: "Changelog", text: "See what's changed in this map/tool itself recently — not the game." },
    { sel: "#hint", title: "Getting around", text: "Drag to pan, scroll to zoom, and click any node to trace the path that leads to it." },
];
let tourIndex = 0;
const tourOverlay = getEl("tourOverlay");
const tourHighlight = getEl("tourHighlight");
const tourPopup = getEl("tourPopup");
const tourText = getEl("tourText");
const tourStepCount = getEl("tourStepCount");
const tourBackBtn = getEl("tourBack");
const tourNextBtn = getEl("tourNext");
function startTour() {
    applyMode("tracker");
    tourOverlay.classList.add("showing");
    showTourStep(0);
}
function endTour() {
    tourOverlay.classList.remove("showing");
    showPendingChangelog();
}
function positionTour(target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    tourHighlight.style.left = r.left - pad + "px";
    tourHighlight.style.top = r.top - pad + "px";
    tourHighlight.style.width = r.width + pad * 2 + "px";
    tourHighlight.style.height = r.height + pad * 2 + "px";
    const pw = tourPopup.offsetWidth || 320, ph = tourPopup.offsetHeight || 140;
    const margin = 14;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(innerWidth - pw - margin, left));
    let top = r.bottom + pad + margin;
    if (top + ph > innerHeight - margin)
        top = r.top - pad - margin - ph;
    if (top < margin)
        top = margin;
    tourPopup.style.left = left + "px";
    tourPopup.style.top = top + "px";
}
function showTourStep(i) {
    const dir = i >= tourIndex ? 1 : -1;
    while (i >= 0 && i < TOUR_STEPS.length) {
        const target = document.querySelector(TOUR_STEPS[i].sel);
        if (target) {
            tourIndex = i;
            const step = TOUR_STEPS[i];
            tourText.innerHTML = `<h4>${escapeHtml(step.title)}</h4><p>${escapeHtml(step.text)}</p>`;
            tourStepCount.textContent = `${i + 1} / ${TOUR_STEPS.length}`;
            tourBackBtn.disabled = i === 0;
            tourNextBtn.textContent = i === TOUR_STEPS.length - 1 ? "Done" : "Next";
            positionTour(target);
            return;
        }
        i += dir;
    }
    endTour();
}
tourNextBtn.addEventListener("click", () => {
    if (tourIndex >= TOUR_STEPS.length - 1) {
        endTour();
        return;
    }
    showTourStep(tourIndex + 1);
});
tourBackBtn.addEventListener("click", () => showTourStep(tourIndex - 1));
getEl("tourSkip").addEventListener("click", endTour);
window.addEventListener("resize", () => {
    if (tourOverlay.classList.contains("showing")) {
        const target = document.querySelector(TOUR_STEPS[tourIndex].sel);
        if (target)
            positionTour(target);
    }
});
applyTheme(currentThemeMode());
buildFlagsPanel();
loadPersistedSave();
{
    let storedMask = null;
    try {
        storedMask = localStorage.getItem("ntrsim-mask-text");
    }
    catch { }
    applyMaskToggle(storedMask !== "0");
}
{
    let storedStrict = null;
    try {
        storedStrict = localStorage.getItem("ntrsim-strict-path");
    }
    catch { }
    applyStrictPathToggle(storedStrict !== "0");
}
{
    let storedGroups = null;
    try {
        storedGroups = localStorage.getItem("ntrsim-show-groups");
    }
    catch { }
    applyGroupsToggle(storedGroups === "1");
}
{
    const startMode = currentViewMode();
    if (startMode === "spoiler") {
        applyMode("tracker");
        confirmSpoilerMode(() => applyMode("spoiler"));
    }
    else {
        applyMode("tracker");
    }
}
resize();
{
    const root = byId.get(rootId);
    centerOn(root.x + root.w / 2, root.y + root.h / 2, 0.55, false);
}
if (!welcomeAcked())
    showWelcomeModal();
else
    showPendingChangelog();
//# sourceMappingURL=app.js.map
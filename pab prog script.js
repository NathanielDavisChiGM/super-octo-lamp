/**
 * ════════════════════════════════════════════════════════════════════
 *   PURE ASSOCIATION OF BASKETBALL  ·  PROGRESSION ENGINE  v2.0
 * ════════════════════════════════════════════════════════════════════
 *   Performance-driven player development for Basketball GM.
 *   Ratings have to be earned on the court, not rolled in a vacuum.
 *
 *   Lead dev ............ Juice T Davis
 *   PER range formulas .. Sabbevis
 *
 *   RUN ORDER
 *     1. Free agency, BEFORE simming to preseason: run the watchlist script.
 *        It flags everyone aged 25+ (teams + free agents) with p.watch = 1.
 *     2. Sim to preseason. BBGM applies its default progs to everyone.
 *     3. Back up your league, then paste THIS file into the worker console.
 *        Only the watched players are re-rolled; everyone else keeps the default prog.
 *     4. With run.dryRun = true nothing is saved. Read the notifications.
 *     5. Happy with the preview? Set run.dryRun = false and run it again.
 *
 *   Forgot step 1? Set run.audience to "age" and it uses minAge instead.
 *
 *   HOW IT WORKS (per player)
 *     last season's PER
 *       -> roll a target OVR change from the PER range
 *       -> run it through the rule pipeline (age, comebacks, streaks, elite tax)
 *       -> spread it across individual ratings (age- and archetype-aware)
 *       -> small chance of a shooting-only breakout
 *
 *   The new ratings row is always rebuilt from LAST season's row, so
 *   re-running re-rolls the same season. It never stacks.
 */
(async function PABProgressionEngine() {
  "use strict";

  /* ══════════════════════════════ CONFIG ══════════════════════════════ */

  const deepFreeze = obj => {
    Object.values(obj).forEach(v => typeof v === "object" && v !== null && deepFreeze(v));
    return Object.freeze(obj);
  };

  const CFG = deepFreeze({
    run: {
      dryRun: false,           // true = preview only, nothing is saved
      undo: false,             // true = put everyone back how they were before the last live run (until you reload the page)
      seed: 7,              // a number = reproducible rolls (compare tunings fairly), null = random
      useArchetypes: true,     // false = every position grows the same way (age curves still apply)
      audience: "watched",     // "watched" = players flagged p.watch === 1 by the watchlist script
                               // "age"     = everyone at least minAge right now (if you forgot the watchlist script)
                               // "all"     = the whole league
      minAge: 26,              // for audience "age": age in the NEW season (25 before the sim = 26 after)
      spotlight: ["Dončić"],   // players to report on after the run (partial names work)
      target70: [35, 45],      // league-wide 70+ OVR count you want; the report tells you if you hit it
      showRangeTable: true,    // print the PER -> range table (and the 80+ ranges) to the console
    },

    per: {
      minMinutes: 250,         // below this, last season's PER is too small a sample to trust
      fallback: { young: 15, vet: 10, youngMaxAge: 22 },
    },

    age: {
      // [maxAge, shift]: added on top of the PER roll
      shift: [[20, 1.5], [22, 1], [24, 0.5], [27, 0], [28, -0.5], [29, -1], [30, -1.5], [32, -2], [Infinity, -3]],
    },

    rules: {
      // At or above threshold OVR: never a positive prog. Range = -(base + over x slope), steeper the higher you are.
      superstar: { threshold: 80, floor: [2, 0.8], ceil: [1, 0.1] },    // 89 OVR -> about -9 to -2
      veteran:  { minAge: 31, maxGain: 1 },             // 31+ can gain at most this much
      comeback: { minAge: 24, gap: 4, damp: 0.4 },      // gap+ below own career peak -> gains x damp
      streak:   { minAge: 25, gain: 2, cap: 1 },        // two straight +gain years -> next gain capped
      elite: {
        softCap: 64,           // OVR where gains start getting taxed
        range: 10,             // gains bottom out at gainFloor by softCap + range
        gainFloor: 0.1,        // share of gains an elite player keeps
        pull: 0.28,            // OVR lost per point above softCap...
        shield: { startPer: 20, span: 12, min: 0.1 },    // ...eased off as PER climbs
      },
    },

    spread: { skipChance: 0.25, jitter: 0.5, maxMove: 8, iterations: 16 },   // maxMove grows automatically for big targets

    breakout: { chance: 0.06, maxAge: 28, maxOvr: 62, fullMinutes: 2000, bonus: [3, 7], ratingCap: 90 },   // stars can't "break out" higher
  });

  /* ═══════════════════════════ RATING MODEL ═══════════════════════════ */

  // hgt is deliberately left alone
  const RATINGS = ["stre", "spd", "jmp", "endu", "ins", "dnk", "ft", "fg", "tp", "oiq", "diq", "drb", "pss", "reb"];

  const GROUP = {
    stre: "athletic", spd: "athletic", jmp: "athletic", endu: "athletic",
    ins: "inside", dnk: "inside",
    ft: "shooting", fg: "shooting", tp: "shooting",
    oiq: "skill", diq: "skill", drb: "skill", pss: "skill", reb: "skill",
  };

  // How much each archetype cares about each rating
  const ARCHETYPES = {
    guard: { tp: 1.2, ft: 1.0, fg: 0.9, drb: 1.2, pss: 1.2, oiq: 1.1, diq: 0.8, spd: 0.5, jmp: 0.3, endu: 0.5, stre: 0.2, ins: 0.3, dnk: 0.3, reb: 0.2 },
    wing:  { tp: 1.0, ft: 0.8, fg: 1.0, drb: 0.7, pss: 0.6, oiq: 1.0, diq: 1.0, spd: 0.5, jmp: 0.5, endu: 0.5, stre: 0.4, ins: 0.6, dnk: 0.6, reb: 0.6 },
    big:   { tp: 0.3, ft: 0.5, fg: 0.6, drb: 0.2, pss: 0.4, oiq: 0.9, diq: 1.1, spd: 0.2, jmp: 0.3, endu: 0.4, stre: 0.8, ins: 1.2, dnk: 0.9, reb: 1.2 },
    flat:  Object.fromEntries(RATINGS.map(r => [r, 1])),
  };

  const GUARD_POS = new Set(["PG", "G", "SG"]);
  const BIG_POS = new Set(["PF", "FC", "C"]);
  const archetypeOf = pos =>
    !CFG.run.useArchetypes ? "flat" : GUARD_POS.has(pos) ? "guard" : BIG_POS.has(pos) ? "big" : "wing";

  // [maxAge, multiplier]. Athleticism stops growing early; skills and IQ grow late.
  const GROWTH = {
    athletic: [[19, 1], [21, 0.8], [23, 0.5], [25, 0.25], [Infinity, 0.05]],
    shooting: [[24, 1], [27, 0.8], [30, 0.5], [Infinity, 0.25]],
    skill:    [[26, 1], [30, 0.8], [Infinity, 0.5]],
    inside:   [[24, 1], [28, 0.7], [Infinity, 0.4]],
  };
  // Athleticism falls off first; shooting and IQ age gracefully.
  const DECLINE = {
    athletic: [[24, 0.2], [27, 0.6], [30, 1.2], [Infinity, 1.8]],
    shooting: [[30, 0.5], [Infinity, 0.8]],
    skill:    [[30, 0.4], [34, 0.8], [Infinity, 1.2]],
    inside:   [[28, 0.4], [Infinity, 0.8]],
  };

  /* ═══════════════════════════ UTILITIES ═══════════════════════════ */

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const bandValue = (bands, x) => bands.find(([max]) => x <= max)[1];

  /** mulberry32: tiny seeded PRNG, so a tuning change can be tested on identical rolls. */
  const makeRng = seed => {
    if (seed == null) return Math.random;
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const rng = makeRng(CFG.run.seed);
  const between = (lo, hi) => lo + rng() * (hi - lo);

  /** Console + in-game toast, so results are visible even without DevTools. */
  const say = (msg, type = "info") => {
    console.log(msg);
    try {
      if (typeof bbgm !== "undefined" && typeof bbgm.logEvent === "function") {
        bbgm.logEvent({ type, text: String(msg).slice(0, 300), saveToDb: false });
      }
    } catch (_) { /* notifications are a nicety, never a requirement */ }
  };

  const ovrOf = ratings => bbgm.player.ovr(ratings);

  /* ═══════════════════════ WHO GETS PROGGED ═══════════════════════ */

  const AUDIENCES = {
    watched: p => p.watch === 1,
    age: (p, season) => season - p.born.year >= CFG.run.minAge,
    all: () => true,
  };

  /* ═══════════════════════ PERFORMANCE (PER) MODEL ═══════════════════════ */

  /** Sabbevis's PER -> [min, max] OVR change, as formulas. */
  const perRange = per => {
    const p = clamp(Math.round(per), 1, 30);
    return [Math.min(0, Math.floor(p / 5) - 5), Math.floor(p / 3) - 3];
  };

  /** Minutes-weighted PER across stints (covers mid-season trades). */
  function readPerformance(player, season) {
    const rows = (player.stats ?? []).filter(s => s.season === season && !s.playoffs && s.min > 0);
    const minutes = rows.reduce((t, s) => t + s.min, 0);
    const weighted = rows.reduce((t, s) => t + (s.per ?? 0) * s.min, 0);
    return { minutes, per: minutes ? weighted / minutes : null };
  }

  /* ═══════════════════════ PLAYER CONTEXT ═══════════════════════ */

  /**
   * Everything the rules need to know about one player, or null if the
   * ratings history has no clean "last season -> new season" pair.
   */
  function buildContext(player, season) {
    const [cur, base, r3, r4] = [-1, -2, -3, -4].map(i => player.ratings.at(i));
    if (!cur || !base || cur.season !== base.season + 1) return null;

    const age = season - player.born.year;
    const { minutes, per: realPer } = readPerformance(player, cur.season - 1);
    const trusted = realPer !== null && minutes >= CFG.per.minMinutes;
    const fb = CFG.per.fallback;

    return {
      player, cur, base, age, minutes, trusted,
      per: trusted ? realPer : age <= fb.youngMaxAge ? fb.young : fb.vet,
      arch: archetypeOf(cur.pos ?? base.pos),
      superstar: base.ovr >= CFG.rules.superstar.threshold,
      start: { ...base, hgt: cur.hgt },
      peak: Math.max(...player.ratings.slice(0, -1).map(r => r.ovr)),
      recentGains: [[base, r3], [r3, r4]].filter(([a, b]) => a && b).map(([a, b]) => a.ovr - b.ovr),
    };
  }

  /* ═══════════════════════ DELTA PIPELINE ═══════════════════════ */

  /** 80+ OVR: the range is always negative and gets steeper the higher you are. */
  function superstarRange(ovr) {
    const { threshold, floor, ceil } = CFG.rules.superstar;
    const over = ovr - threshold;
    return [-(floor[0] + over * floor[1]), -(ceil[0] + over * ceil[1])];
  }

  /** Step 1: the range this player rolls in. PER sets it, age nudges it, superstars override it. */
  function rollRange(ctx) {
    if (ctx.superstar) return superstarRange(ctx.base.ovr);
    const [lo, hi] = perRange(ctx.per);
    const shift = bandValue(CFG.age.shift, ctx.age);
    return [lo + shift, hi + shift];
  }

  const fmtRange = ([lo, hi]) => `${Math.round(lo)}..${Math.round(hi)}`;

  /** Step 2: each rule takes (delta, ctx) and returns a new delta. Order matters. */
  const RULES = [
    /** Far below your own peak? Comebacks are slow. */
    function comebackDamp(d, c) {
      const r = CFG.rules.comeback;
      return d > 0 && c.age >= r.minAge && c.peak - c.base.ovr >= r.gap ? d * r.damp : d;
    },

    /** Two big years in a row? Cool off. */
    function streakFade(d, c) {
      const r = CFG.rules.streak;
      const onStreak = c.recentGains.length === 2 && c.recentGains.every(g => g >= r.gain);
      return d > 0 && c.age >= r.minAge && onStreak ? Math.min(d, r.cap) : d;
    },

    /** Old legs don't get big gains. */
    function veteranCap(d, c) {
      const r = CFG.rules.veteran;
      return d > 0 && c.age >= r.minAge ? Math.min(d, r.maxGain) : d;
    },

    /** Above the soft cap gains get taxed and everyone is pulled down, unless PER backs the rating. */
    function eliteTax(d, c) {
      const r = CFG.rules.elite;
      const over = c.base.ovr - r.softCap;
      if (c.superstar || over <= 0) return d;               // superstars already have their own negative range

      const taxed = d > 0 ? d * Math.max(r.gainFloor, 1 - over / r.range) : d;
      const shield = clamp(1 - (c.per - r.shield.startPer) / r.shield.span, r.shield.min, 1);
      return taxed - over * r.pull * shield;
    },
  ];

  const applyRules = (d, ctx) => RULES.reduce((acc, rule) => rule(acc, ctx), d);

  /* ═══════════════════════ SPREADING ═══════════════════════ */

  /** Normalized weight per rating for this archetype, age and direction (null = nothing moves). */
  function buildShares(arch, age, direction) {
    const { skipChance, jitter } = CFG.spread;
    const curve = direction > 0 ? GROWTH : DECLINE;

    const raw = Object.fromEntries(RATINGS.map(r => [
      r,
      rng() < skipChance ? 0 : ARCHETYPES[arch][r] * bandValue(curve[GROUP[r]], age) * between(1 - jitter, 1 + jitter),
    ]));
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    return total ? Object.fromEntries(RATINGS.map(r => [r, raw[r] / total])) : null;
  }

  /**
   * Bisect on a scale factor until the real OVR change lands closest to the
   * target. Using the game's own ovr() means we never hard-code its formula.
   */
  function spreadToTarget(start, shares, target, direction) {
    const { maxMove: baseMove, iterations } = CFG.spread;
    const maxMove = Math.max(baseMove, Math.ceil(target * 1.5));   // a -9 prog needs room to move
    const startOvr = ovrOf(start);

    const build = scale => {
      const out = { ...start };
      for (const r of RATINGS) {
        const move = clamp(Math.round(direction * scale * shares[r]), -maxMove, maxMove);
        out[r] = clamp(start[r] + move, 0, 100);
      }
      return out;
    };

    let [lo, hi] = [0, 250];
    let best = start, bestErr = target;
    for (let i = 0; i < iterations; i++) {
      const mid = (lo + hi) / 2;
      const candidate = build(mid);
      const achieved = direction * (ovrOf(candidate) - startOvr);
      const err = Math.abs(achieved - target);
      if (err < bestErr) [best, bestErr] = [candidate, err];
      achieved < target ? (lo = mid) : (hi = mid);
    }
    return best;
  }

  /* ═══════════════════════ BREAKOUTS ═══════════════════════ */

  /** Rotation players get picked far more often than bench players. Shooting ratings only. */
  function rollBreakout(ratings, ctx) {
    const b = CFG.breakout;
    if (ctx.age > b.maxAge || ctx.base.ovr > b.maxOvr) return { ratings, hit: false };

    const usage = clamp(ctx.minutes / b.fullMinutes, 0, 1);
    if (rng() >= b.chance * (0.15 + 0.85 * usage)) return { ratings, hit: false };

    const bonus = Math.round(between(...b.bonus));
    const targets = ctx.arch === "big" ? ["fg", "ft", "ins"] : ["fg", "tp", "ft"];
    const parts = targets.map(() => rng() + 0.3);
    const total = parts.reduce((a, c) => a + c, 0);

    const boosted = { ...ratings };
    targets.forEach((r, i) => {
      boosted[r] = clamp(boosted[r] + Math.round((bonus * parts[i]) / total), 0, Math.max(b.ratingCap, boosted[r]));
    });
    return { ratings: boosted, hit: true };
  }

  /* ═══════════════════════ ONE PLAYER, START TO FINISH ═══════════════════════ */

  function progress(ctx) {
    const range = rollRange(ctx);
    const target = applyRules(between(...range), ctx);
    const direction = target >= 0 ? 1 : -1;
    const shares = buildShares(ctx.arch, ctx.age, direction);
    const spread = shares ? spreadToTarget(ctx.start, shares, Math.abs(target), direction) : ctx.start;
    const { ratings, hit } = rollBreakout(spread, ctx);
    const after = ovrOf(ratings);

    return {
      ctx, ratings,
      row: {
        name: `${ctx.player.firstName} ${ctx.player.lastName}`,
        age: ctx.age, pos: ctx.cur.pos, per: ctx.trusted ? +ctx.per.toFixed(1) : "n/a",
        range: fmtRange(range), target: +target.toFixed(1),
        before: ctx.base.ovr, after, change: after - ctx.base.ovr, breakout: hit,
      },
    };
  }

  /** Keeps the ORIGINAL ratings of everyone we touch, so a bad run can be undone this session. */
  function backupOriginal(ctx, season) {
    if (globalThis.PAB_UNDO?.season !== season) globalThis.PAB_UNDO = { season, players: {} };
    const { pid } = ctx.player;
    globalThis.PAB_UNDO.players[pid] ??= Object.fromEntries([...RATINGS, "hgt", "ovr", "pot", "pos"].map(k => [k, ctx.cur[k]]));
  }

  async function undoLastRun() {
    const saved = globalThis.PAB_UNDO;
    if (!saved || !Object.keys(saved.players).length) {
      throw new Error("Nothing to undo. The backup only lives until the page is reloaded.");
    }
    let restored = 0;
    for (const p of await bbgm.idb.cache.players.getAll()) {
      const snapshot = saved.players[p.pid];
      if (!snapshot) continue;
      Object.assign(p.ratings.at(-1), snapshot);
      await bbgm.player.updateValues(p);
      await bbgm.idb.cache.players.put(p);
      restored++;
    }
    say(`↩️ UNDONE: ${restored} players restored to their pre-run ratings (season ${saved.season}).`, "success");
  }

  async function save({ ctx, ratings }, season) {
    backupOriginal(ctx, season);
    for (const r of RATINGS) ctx.cur[r] = ratings[r];
    await bbgm.player.develop(ctx.player, 0);          // refreshes ovr / pot / pos from the new ratings
    await bbgm.player.updateValues(ctx.player);
    await bbgm.idb.cache.players.put(ctx.player);
  }

  /** Console view of every range the engine can roll (before the age nudge). */
  function showRangeTables() {
    console.log("PER -> OVR prog range (age 25-27, before rules)");
    console.table(Array.from({ length: 30 }, (_, i) => {
      const [min, max] = perRange(i + 1);
      return { PER: i + 1, min, max, avg: (min + max) / 2 };
    }));
    console.log("80+ OVR prog range (never positive)");
    console.table([80, 82, 85, 88, 89, 92, 95].map(ovr => {
      const [lo, hi] = superstarRange(ovr);
      return { OVR: ovr, min: +lo.toFixed(1), max: +hi.toFixed(1), avg: +((lo + hi) / 2).toFixed(1) };
    }));
  }

  /* ═══════════════════════ REPORTING ═══════════════════════ */

  function report({ rows, skipped, outside, fallbackCount, season, phase }) {
    const count70 = key => rows.filter(r => r[key] >= 70).length;
    const topBefore = [...rows].sort((a, b) => b.before - a.before).slice(0, 150).map(r => r.before);
    const topAfter = [...rows].sort((a, b) => b.after - a.after);

    const outside70 = key => outside.filter(p => p.ratings.at(key === "before" ? -2 : -1)?.ovr >= 70).length;
    say(`70+ OVR league-wide: ${count70("before") + outside70("before")} -> ${count70("after") + outside70("after")} | progressed top-150 avg ${avg(topBefore).toFixed(1)} -> ${avg(topAfter.slice(0, 150).map(r => r.after)).toFixed(1)} | skipped ${skipped.length}, fallback PER ${fallbackCount}`);
    const league70 = count70("after") + outside70("after");
    const [lo70, hi70] = CFG.run.target70;
    const verdict = league70 > hi70 ? `⬇️ ${league70 - hi70} too many` : league70 < lo70 ? `⬆️ ${lo70 - league70} too few` : "✅ in range";
    say(`🎯 70+ OVR after: ${league70} (target ${lo70}-${hi70}): ${verdict}`);
    say("Top 8 after: " + topAfter.slice(0, 8).map(r => `${r.name} ${r.before}→${r.after}`).join(", "));

    for (const query of CFG.run.spotlight) {
      const q = query.toLowerCase();
      const hits = rows.filter(r => r.name.toLowerCase().includes(q));
      const missed = skipped.filter(s => s.name.toLowerCase().includes(q));
      hits.forEach(r => say(`👀 ${r.name} (${r.age}): ${r.before} -> ${r.after}, PER ${r.per}, range ${r.range}, rolled ${r.target}`));
      missed.forEach(s => say(`👀 ${s.name} (${s.age}) was SKIPPED. ratings seasons: ${s.seasons.join(", ")}`, "error"));
      if (!hits.length && !missed.length) say(`👀 No player matching "${query}" (retired, prospect, or typo)`);
    }

    console.log("Biggest risers");  console.table([...rows].sort((a, b) => b.change - a.change).slice(0, 10));
    console.log("Biggest fallers"); console.table([...rows].sort((a, b) => a.change - b.change).slice(0, 10));
    console.log("Breakouts");       console.table(rows.filter(r => r.breakout));

    if (!rows.length) {
      say(`⚠️ Ran fine but processed 0 players. season=${season}, phase=${phase}. Send me this line.`, "error");
    } else if (CFG.run.dryRun) {
      say(`✅ DRY RUN WORKED: previewed ${rows.length} players. Nothing was changed. Set run.dryRun to false to apply.`, "success");
    } else {
      say(`✅ IT WORKED: ${rows.length} players progressed and saved. 🏀 PAB Progression Engine v2`, "success");
    }
  }

  /* ═══════════════════════ MAIN ═══════════════════════ */

  function preflight() {
    if (typeof bbgm === "undefined") {
      throw new Error("No `bbgm` object. Use the WORKER console (Danger Zone), not the browser console.");
    }
    const required = ["player.ovr", "player.develop", "player.updateValues", "idb.cache.players.getAll", "idb.cache.players.put", "g.get"];
    const missing = required.filter(path => typeof path.split(".").reduce((o, k) => o?.[k], bbgm) !== "function");
    if (missing.length) throw new Error(`Console API missing: ${missing.join(", ")}. Send me this message.`);
  }

  try {
    say(`🏀 PAB PROGRESSION ENGINE v2 · ${CFG.run.dryRun ? "DRY RUN" : "LIVE"} · seed ${CFG.run.seed ?? "random"}`);
    preflight();
    if (CFG.run.undo) { await undoLastRun(); return; }

    const season = bbgm.g.get("season");
    const phase = bbgm.g.get("phase");
    const inScope = AUDIENCES[CFG.run.audience];
    if (!inScope) throw new Error(`Unknown run.audience "${CFG.run.audience}". Use "watched", "age" or "all".`);

    const everyone = (await bbgm.idb.cache.players.getAll()).filter(p => p.tid >= -1);   // teams + free agents
    const players = everyone.filter(p => inScope(p, season));
    const outside = everyone.filter(p => !inScope(p, season));
    if (!players.length) {
      throw new Error(CFG.run.audience === "watched"
        ? 'No players are flagged p.watch = 1. Run the watchlist script first, or set run.audience to "age".'
        : "No players matched run.audience.");
    }
    say(`${players.length} in scope (${CFG.run.audience}), ${outside.length} left on default progs · season ${season}, phase ${phase}`);
    if (CFG.run.showRangeTable) showRangeTables();

    const rows = [], skipped = [];
    let fallbackCount = 0;

    for (const player of players) {
      const ctx = buildContext(player, season);
      if (!ctx) {
        skipped.push({ name: `${player.firstName} ${player.lastName}`, age: season - player.born.year, seasons: player.ratings.slice(-3).map(r => r.season) });
        continue;
      }
      if (!ctx.trusted) fallbackCount++;

      const result = progress(ctx);
      rows.push(result.row);
      if (!CFG.run.dryRun) await save(result, season);
    }

    report({ rows, skipped, outside, fallbackCount, season, phase });
  } catch (err) {
    say(`❌ SCRIPT FAILED: ${err.message}`, "error");
    console.error("Send this to me and I'll fix it:", err);
  }
})();

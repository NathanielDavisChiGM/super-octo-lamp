/**
 * ════════════════════════════════════════════════════════════════════
 *   PURE ASSOCIATION OF BASKETBALL  ·  WATCHLIST TAGGER  v2.0
 * ════════════════════════════════════════════════════════════════════
 *   Step 1 of 2. Flags every player the PAB Progression Engine should
 *   re-roll by setting p.watch = 1 (everyone else gets p.watch = 0).
 *
 *   Lead dev ............ Juice T Davis
 *
 *   RUN ORDER
 *     1. During free agency, BEFORE simming to preseason: run THIS file
 *        in the BBGM worker console (Danger Zone).
 *     2. Sim to preseason. BBGM applies its default progs.
 *     3. Run pab_prog_script.js (the Progression Engine).
 *
 *   Forgot step 1 and already simmed? Leave autoAgeFix on. Ages have
 *   rolled over by a year, so the tagger bumps minAge by one for you.
 */
(async function PABWatchlistTagger() {
  "use strict";

  /* ══════════════════════════════ CONFIG ══════════════════════════════ */

  const CFG = Object.freeze({
    minAge: 25,               // age at free agency time (becomes 26 once the new season starts)
    includeFreeAgents: true,  // free agents get progged too
    autoAgeFix: true,         // already simmed into the new season? add a year to minAge automatically
  });

  // Phases 0-6 are the new season (preseason through after-draft). 7 and 8 are re-signing and free agency.
  const SEASON_ALREADY_ROLLED = phase => phase >= 0 && phase <= 6;

  /* ══════════════════════════════ HELPERS ══════════════════════════════ */

  /** Console + in-game toast, so results are visible even without DevTools. */
  const say = (msg, type = "info") => {
    console.log(msg);
    try {
      if (typeof bbgm !== "undefined" && typeof bbgm.logEvent === "function") {
        bbgm.logEvent({ type, text: String(msg).slice(0, 300), saveToDb: false });
      }
    } catch (_) { /* notifications are a nicety, never a requirement */ }
  };

  function preflight() {
    if (typeof bbgm === "undefined") {
      throw new Error("No `bbgm` object. Use the WORKER console (Danger Zone), not the browser console.");
    }
    const required = ["idb.cache.players.getAll", "g.get"];
    const missing = required.filter(path => typeof path.split(".").reduce((o, k) => o?.[k], bbgm) !== "function");
    if (missing.length) throw new Error(`Console API missing: ${missing.join(", ")}. Send me this message.`);
  }

  /* ══════════════════════════════ MAIN ══════════════════════════════ */

  try {
    say("🏀 PAB WATCHLIST TAGGER v2");
    preflight();

    const season = bbgm.g.get("season");
    const phase = bbgm.g.get("phase");

    const rolled = CFG.autoAgeFix && SEASON_ALREADY_ROLLED(phase);
    const minAge = CFG.minAge + (rolled ? 1 : 0);
    if (rolled) say(`Season already rolled over (phase ${phase}), so the cutoff is ${minAge} instead of ${CFG.minAge}.`);

    const lowestTid = CFG.includeFreeAgents ? -1 : 0;     // -1 = free agent, -2 = prospect, -3 = retired
    const players = await bbgm.idb.cache.players.getAll();

    let flagged = 0, freeAgents = 0;
    for (const p of players) {
      const watched = p.tid >= lowestTid && season - p.born.year >= minAge;
      p.watch = watched ? 1 : 0;
      await bbgm.idb.cache.players.put?.(p);              // cache objects are live; put makes sure it's saved
      if (watched) {
        flagged++;
        if (p.tid === -1) freeAgents++;
      }
    }

    say(`✅ WATCHLIST SET: ${flagged} players flagged (${freeAgents} free agents), ${players.length - flagged} left on default progs. Age cutoff ${minAge}, season ${season}, phase ${phase}.`, "success");
  } catch (err) {
    say(`❌ WATCHLIST FAILED: ${err.message}`, "error");
    console.error("Send this to me and I'll fix it:", err);
  }
})();

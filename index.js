'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function LaurelChanger(mod) {

    // Laurel grades:
    // 0 = None, 1 = Bronze, 2 = Silver, 3 = Gold, 4 = Diamond, 5 = Champion
    const laurelNames = {
        0: 'None', 1: 'Bronze', 2: 'Silver',
        3: 'Gold', 4: 'Diamond', 5: 'Champion'
    };

    // Points that guarantee each grade. 100.02 seasons need ~17k for champion,
    // so 9999 is only gold/diamond. Use a huge cap.
    const laurelPointsMap = {
        0: 0, 1: 1, 2: 50, 3: 350, 4: 1250, 5: 999999
    };

    // 100.02 TW datasheet seasons 1-10. Extra ids cover Asura/EU clients.
    const SEASON_COUNT = 12;
    const SEASON_START_UNIX = {
        1: 1415836800,  // 2014-11-13
        2: 1423008000,  // 2015-02-04
        3: 1435190400,  // 2015-06-25
        4: 1453766400,  // 2016-01-26
        5: 1468368000,  // 2016-07-13
        6: 1484179200,  // 2017-01-12
        7: 1499904000,  // 2017-07-13
        8: 1515024000,  // 2018-01-04
        9: 1531353600,  // 2018-07-12
        10: 1544054400, // 2018-12-06 (current 100.02 season)
        11: 1560124800, // 2019-06-10
        12: 1575590400  // 2019-12-06
    };

    const HOOK_OPTS = { order: 10000, filter: { fake: null } };
    const RESEND_DELAYS = [0, 50, 150, 400, 1200, 3000, 7000];

    let desiredLaurel = (mod.settings && mod.settings.laurel !== undefined) ? mod.settings.laurel : 5;
    let lastAchievementEvent = null;
    let achievementListVersion = null;
    let achievementSeeded = false;
    const cachePath = path.join(__dirname, 'achievement_cache.json');

    // ---------- Disk-backed cache so reloads don't lose the baseline ----------

    function loadCache() {
        try {
            if (!fs.existsSync(cachePath)) return;
            const raw = fs.readFileSync(cachePath, 'utf8');
            const parsed = JSON.parse(raw, (_, v) =>
                (typeof v === 'string' && /^bigint:/.test(v)) ? BigInt(v.slice(7)) : v);
            if (!parsed || typeof parsed !== 'object') return;

            if (parsed.version && parsed.data) {
                achievementListVersion = parsed.version;
                lastAchievementEvent = parsed.data;
            } else if (parsed.gameId !== undefined) {
                achievementListVersion = 2;
                lastAchievementEvent = parsed;
            } else if (parsed.cid !== undefined) {
                achievementListVersion = 1;
                lastAchievementEvent = parsed;
            }
            if (lastAchievementEvent && achievementListVersion) achievementSeeded = true;
        } catch (_) { /* ignore — first run or corrupt file */ }
    }

    function saveCache() {
        try {
            if (!lastAchievementEvent || !achievementListVersion) return;
            const payload = {
                version: achievementListVersion,
                data: lastAchievementEvent
            };
            const json = JSON.stringify(payload, (_, v) =>
                typeof v === 'bigint' ? `bigint:${v.toString()}` : v);
            fs.writeFileSync(cachePath, json);
        } catch (_) { /* non-fatal */ }
    }

    function saveSettings() {
        if (!mod.settings) return;
        mod.settings.laurel = desiredLaurel;
        try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
    }

    function getDesiredPoints() {
        return desiredLaurel === 0 ? 0 : (laurelPointsMap[desiredLaurel] || 999999);
    }

    function bindCacheToMe(event) {
        if (!lastAchievementEvent || !event) return;
        const gid = event.gameId !== undefined ? event.gameId : event.cid;
        if (gid === undefined) return;
        if (lastAchievementEvent.cid !== undefined) lastAchievementEvent.cid = gid;
        if (lastAchievementEvent.gameId !== undefined) lastAchievementEvent.gameId = gid;
    }

    function cloneAchievementEvent(event) {
        if (!event) return null;
        const clone = Object.assign({}, event);
        if (clone.achievements) {
            clone.achievements = clone.achievements.map(a => Object.assign({}, a));
        }
        if (clone.history) {
            clone.history = clone.history.map(h => Object.assign({}, h));
        }
        return clone;
    }

    // ---------- Patching ----------

    function toInt64(v) {
        if (typeof v === 'bigint') return v;
        if (v == null || v === '') return 0n;
        try { return BigInt(v); } catch (_) { return 0n; }
    }

    function isEmptyTimestamp(v) {
        if (v == null || v === '') return true;
        try { return BigInt(v) === 0n; } catch (_) { return true; }
    }

    function seasonStartUnix(season) {
        const n = Number(season);
        const unix = SEASON_START_UNIX[n] || (SEASON_START_UNIX[10] + Math.max(0, n - 10) * 15552000);
        return BigInt(unix);
    }

    function patchHistory(event) {
        if (!event) return false;
        let changed = false;
        if (!Array.isArray(event.history)) {
            event.history = [];
            changed = true;
        }

        const bySeason = new Map();
        for (const row of event.history) {
            if (!row || row.season == null) continue;
            const season = Number(row.season);
            if (!Number.isFinite(season)) continue;
            if (row.laurel !== desiredLaurel) {
                row.laurel = desiredLaurel;
                changed = true;
            }
            const ts = seasonStartUnix(season);
            if (isEmptyTimestamp(row.startDate) && ts) {
                row.startDate = ts;
                changed = true;
            }
            if (isEmptyTimestamp(row.seasonStartTime) && ts) {
                row.seasonStartTime = ts;
                changed = true;
            }
            bySeason.set(season, row);
        }

        // 100.02 draws the crown from history[], not from points alone.
        // An empty list (fresh character) shows no laurel at all.
        for (let season = 1; season <= SEASON_COUNT; season++) {
            if (bySeason.has(season)) continue;
            const ts = seasonStartUnix(season);
            event.history.push({
                season,
                laurel: desiredLaurel,
                startDate: ts,
                seasonStartTime: ts,
            });
            changed = true;
        }
        return changed;
    }

    function patchEventV2(event) {
        let changed = false;
        const target = getDesiredPoints();
        if (event.laurelPoints !== target) {
            event.laurelPoints = target;
            changed = true;
        }
        if (patchHistory(event)) changed = true;
        return changed;
    }

    function patchEventV1(event) {
        let changed = false;
        const target = getDesiredPoints();
        if (event.unk3 !== target) {
            event.unk3 = target;
            changed = true;
        }
        if (patchHistory(event)) changed = true;
        return changed;
    }

    function patchAppearance(event) {
        if (!event) return false;
        let changed = false;
        if (event.laurel !== undefined && event.laurel !== desiredLaurel) {
            event.laurel = desiredLaurel;
            changed = true;
        }
        if (event.achievementLevel !== undefined && event.achievementLevel !== desiredLaurel) {
            event.achievementLevel = desiredLaurel;
            changed = true;
        }
        return changed;
    }

    function storeAchievementSnapshot(event, version) {
        lastAchievementEvent = cloneAchievementEvent(event);
        achievementListVersion = version;
        achievementSeeded = true;
        saveCache();
    }

    mod.hook('S_LOAD_ACHIEVEMENT_LIST', 2, HOOK_OPTS, (event, fake) => {
        patchEventV2(event);
        if (!fake) storeAchievementSnapshot(event, 2);
        return true;
    });

    mod.tryHook('S_LOAD_ACHIEVEMENT_LIST', 1, HOOK_OPTS, (event, fake) => {
        patchEventV1(event);
        if (!fake) storeAchievementSnapshot(event, 1);
        return true;
    });

    mod.hook('S_GET_USER_LIST', '*', HOOK_OPTS, (event) => {
        if (!event.characters) return;
        let changed = false;
        for (const char of event.characters) {
            if ('laurel' in char && char.laurel !== desiredLaurel) {
                char.laurel = desiredLaurel;
                changed = true;
            }
            if ('achievementLevel' in char && char.achievementLevel !== desiredLaurel) {
                char.achievementLevel = desiredLaurel;
                changed = true;
            }
            if ('achievementPoints' in char && char.achievementPoints !== getDesiredPoints()) {
                char.achievementPoints = getDesiredPoints();
                changed = true;
            }
        }
        if (changed) return true;
    });

    // ---------- Resend orchestration ----------

    function scheduleResendBurst() {
        if (!lastAchievementEvent || !achievementListVersion) return;
        achievementSeeded = true;
        for (const delay of RESEND_DELAYS) {
            mod.setTimeout(() => resendAchievement(), delay);
        }
    }

    function resendAchievement() {
        if (!achievementSeeded || !lastAchievementEvent || !achievementListVersion) return;
        try {
            const pkt = cloneAchievementEvent(lastAchievementEvent);
            const target = getDesiredPoints();

            patchHistory(pkt);
            if (pkt.history) {
                for (const row of pkt.history) {
                    if (row.startDate !== undefined) row.startDate = toInt64(row.startDate);
                    if (row.seasonStartTime !== undefined) row.seasonStartTime = toInt64(row.seasonStartTime);
                }
            }
            if (achievementListVersion === 2) {
                pkt.laurelPoints = target;
                mod.trySend('S_LOAD_ACHIEVEMENT_LIST', 2, pkt);
            } else {
                pkt.unk3 = target;
                mod.trySend('S_LOAD_ACHIEVEMENT_LIST', 1, pkt);
            }
        } catch (_) { /* silently fail individual resend */ }
    }

    mod.tryHook('S_LOGIN', '*', (event) => {
        bindCacheToMe(event);
        if (lastAchievementEvent && achievementListVersion) achievementSeeded = true;
        const changed = patchAppearance(event);
        scheduleResendBurst();
        if (changed) return true;
    });

    mod.tryHook('S_SPAWN_ME', '*', (event) => {
        bindCacheToMe(event);
        const changed = patchAppearance(event);
        scheduleResendBurst();
        if (changed) return true;
    });

    mod.hook('S_LOAD_TOPO', '*', () => scheduleResendBurst());

    let onChangeZone = null;
    if (mod.game && mod.game.me) {
        onChangeZone = () => scheduleResendBurst();
        mod.game.me.on('change_zone', onChangeZone);
    }

    // ---------- Command ----------

    mod.command.add('laurel', (arg) => {
        if (arg === undefined) {
            mod.command.message(`Current laurel: ${laurelNames[desiredLaurel]} (${desiredLaurel})`);
            mod.command.message('Usage: /8 laurel [0-5]  (0=None, 1=Bronze, 2=Silver, 3=Gold, 4=Diamond, 5=Champion)');
            return;
        }
        const val = parseInt(arg, 10);
        if (isNaN(val) || val < 0 || val > 5) {
            mod.command.message('Invalid. Use 0-5: 0=None, 1=Bronze, 2=Silver, 3=Gold, 4=Diamond, 5=Champion');
            return;
        }
        desiredLaurel = val;
        saveSettings();
        mod.command.message(`Laurel set to ${laurelNames[val]} (${val}). Persisting…`);

        scheduleResendBurst();
        if (!achievementSeeded) {
            mod.command.message('Open your profile once or relog to seed the cache, then it will persist across channels and reloads.');
        }
    });

    // ---------- Boot ----------

    loadCache();
    if (lastAchievementEvent) {
        if (achievementListVersion === 2) patchEventV2(lastAchievementEvent);
        else patchEventV1(lastAchievementEvent);
        saveCache();
    }

    const log = (msg) => {
        try { mod.command.message(`[laurel] ${msg}`); } catch (_) {}
    };
    log(`${laurelNames[desiredLaurel]} (${desiredLaurel}) is on. Reload Toolbox, then relog.`);

    this.destructor = () => {
        try { saveCache(); } catch (_) {}
        if (onChangeZone && mod.game && mod.game.me) {
            mod.game.me.removeListener('change_zone', onChangeZone);
        }
        mod.command.remove('laurel');
    };
};

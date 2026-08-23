'use strict';

const DefaultSettings = {
    laurel: 5 // Champion
};

module.exports = function MigrateSettings(from_ver, to_ver, settings) {
    if (from_ver === undefined) return { ...DefaultSettings, ...settings };
    if (from_ver === null) return { ...DefaultSettings };

    from_ver = Number(from_ver);
    to_ver = Number(to_ver);

    if (from_ver + 1 < to_ver) {
        settings = MigrateSettings(from_ver, from_ver + 1, settings);
        return MigrateSettings(from_ver + 1, to_ver, settings);
    }

    const oldSettings = settings || {};
    const merged = { ...DefaultSettings };
    for (const key of Object.keys(oldSettings)) {
        if (merged[key] !== undefined) merged[key] = oldSettings[key];
    }
    return merged;
};

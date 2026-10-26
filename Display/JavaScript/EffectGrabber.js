(function () {
'use strict';

// Looks up effects (explosions, flares …) from each plugin's effects data and loads their sprites.

// Per-plugin effect maps: outputName → { map: { name → effect }, ready: bool }
const _pluginEffects  = {};
const _pluginLoading  = {}; // outputName → Promise while loading
const LOCAL_PLUGIN_ID = '__local_builds__';

let _currentPlugin = null;


// one plugin's effects

async function _loadPluginEffects(outputName) {
    if (_pluginEffects[outputName]?.ready) return;
    if (_pluginLoading[outputName])        return _pluginLoading[outputName];

    _pluginLoading[outputName] = (async () => {
        try {
            async function buildFresh() {
                const { fetchAllRows } = window.SupabaseHelpers;

                const { data: pluginRows, error: pluginErr } = await window.supabaseClient
                    .from('plugins').select('plugin_id').eq('output_name', outputName);
                if (pluginErr || !pluginRows?.length) throw new Error(`unknown plugin`);
                const pluginRow = pluginRows[0];

                const rows = await fetchAllRows('effects', { filters: q => q.eq('plugin_id', pluginRow.plugin_id), orderBy: 'id' });

                const map = {};
                rows.forEach(row => {
                    if (!row.name) return;
                    map[row.name] = {
                        name: row.name,
                        sprite: row.sprite,
                        sound: row.sound,
                        lifetime: row.lifetime,
                        'random angle': row.random_angle,
                        'random frame rate': row.random_frame_rate,
                        'random spin': row.random_spin,
                        'random velocity': row.random_velocity,
                        'velocity scale': row.velocity_scale,
                        // Both spellings kept — this file reads .spriteData below,
                        // other code may read the space-separated form instead.
                        spriteData: row.sprite_data,
                        'sprite data': row.sprite_data,
                    };
                });
                return { map, count: rows.length };
            }

            const built = window.EsCache
                ? await window.EsCache.loadWithCache(`effects:${outputName}`, buildFresh)
                : await buildFresh();

            _pluginEffects[outputName] = { map: built.map, ready: true };
            console.log(`EffectGrabber: loaded ${built.count} effects from "${outputName}"`);
        } catch (err) {
            // Plugin may not have effects — that's fine
            console.log(`EffectGrabber: no effects for "${outputName}" (${err.message})`);
            _pluginEffects[outputName] = { map: {}, ready: true };
        }
        delete _pluginLoading[outputName];
    })();

    return _pluginLoading[outputName];
}


// which plugin to look in first

function setEffectPlugin(outputName) {
    _currentPlugin = outputName;
    if (outputName && outputName !== LOCAL_PLUGIN_ID) _loadPluginEffects(outputName);
}


// find an effect across plugins

function _findEffect(effectName) {
    // Search order: current plugin first, then all others
    const order = _currentPlugin ? [_currentPlugin] : [];
    for (const name of Object.keys(_pluginEffects)) {
        if (name !== _currentPlugin) order.push(name);
    }

    for (const name of order) {
        const entry = _pluginEffects[name];
        if (!entry?.ready) continue;
        const effect = entry.map[effectName];
        if (effect) return { effect, sourcePlugin: name };
    }

    return null;
}


// an effect's sprite by name

async function fetchEffectByName(effectName, spriteParams) {
    if (!effectName) {
        console.warn('EffectGrabber: no effectName provided');
        return null;
    }

    // Ensure current plugin's effects are loaded
    if (_currentPlugin && !_pluginEffects[_currentPlugin]?.ready) {
        await _loadPluginEffects(_currentPlugin);
    }

    // Also load any other known plugins that haven't been loaded yet
    const knownPlugins = window.allData ? Object.keys(window.allData) : [];
    await Promise.all(
        knownPlugins
            .filter(name => name !== LOCAL_PLUGIN_ID && !_pluginEffects[name]?.ready && !_pluginLoading[name])
            .map(name => _loadPluginEffects(name))
    );

    const found = _findEffect(effectName);

    // Return null silently — caller will try other methods
    if (!found || !found.effect.sprite) return null;

    const { effect, sourcePlugin } = found;

    if (sourcePlugin !== _currentPlugin) {
        console.log(`EffectGrabber: "${effectName}" found in "${sourcePlugin}" (fallback)`);
    } else {
        console.log(`EffectGrabber: "${effectName}" → "${effect.sprite}"`);
    }

    // Use effect's own spriteData unless caller supplied params
    const params = (spriteParams && Object.keys(spriteParams).length > 0)
        ? spriteParams
        : (effect.spriteData || {});

    // fetchSpriteExact here (fetchSprite would loop back to us)
    if (typeof window.fetchSpriteExact !== 'function') {
        console.error('EffectGrabber: fetchSpriteExact not available — is ImageGrabber loaded?');
        return null;
    }
    return await window.fetchSpriteExact(effect.sprite, params);
}


// ── globals ──

window.fetchEffectByName = fetchEffectByName;
window.setEffectPlugin   = setEffectPlugin;

})();

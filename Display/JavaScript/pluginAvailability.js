'use strict';

// Badges and notices for designs that need a plugin the site no longer has.

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CACHE_KEY = 'es_removed_plugins_v1';
  let index = null;

  // removed-plugin rows
  function setRows(rows) {
    index = window.PluginRefs ? window.PluginRefs.indexRemoved(rows) : null;
  }

  // last known list straight away (so badges show before the network answers)
  try { const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); if (c) setRows(c); } catch (_) {}

  const ready = (async () => {
    const sb = window.supabaseClient;
    if (!sb || !window.PluginRefs) return;
    try {
      const { data, error } = await sb.from('removed_plugins')
        .select('plugin_id, output_name, display_name, source_name, repository, removed_at');
      if (error) return;                         // table not created yet — nothing to show
      setRows(data || []);
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data || [])); } catch (_) {}
    } catch (_) { /* offline */ }
    document.dispatchEvent(new CustomEvent('pluginAvailabilityReady'));
  })();

  // what's missing for a design
  function missing(design) {
    if (!index || !window.PluginRefs) return [];
    return window.PluginRefs.missingFor(design, index);
  }

  const repoLabel = url => String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '');
  const when = iso => { try { return new Date(iso).toLocaleDateString(); } catch (_) { return ''; } };

  // tooltip text
  function tooltip(m) {
    const uses = m.uses.length ? ` (${m.uses.slice(0, 5).join(', ')}${m.uses.length > 5 ? '…' : ''})` : '';
    return `This ship uses ${m.display_name}${uses}, which was removed from the site${m.removed_at ? ' on ' + when(m.removed_at) : ''}.` +
      (m.repository ? ` It comes from ${repoLabel(m.repository)} — install it in Endless Sky to fly this ship, or ask for it to be added back to the site.` : '');
  }

  // ⚠ badge
  function badgeHtml(design) {
    return missing(design).map(m => {
      const inner = `⚠ Needs ${h(m.display_name)}`;
      const style = 'font-size:0.65rem;margin-left:6px;background:var(--c-warn-bg, #78350f);color:var(--c-warn-text, #fbbf24);';
      return m.repository
        ? `<a class="badge" style="${style}text-decoration:none;" href="${h(m.repository)}" target="_blank" rel="noopener" title="${h(tooltip(m))}" onclick="event.stopPropagation()">${inner}</a>`
        : `<span class="badge" style="${style}" title="${h(tooltip(m))}">${inner}</span>`;
    }).join('');
  }

  // notice text
  function noticeHtml(design) {
    const list = missing(design);
    if (!list.length) return '';
    return `<div style="border:1px solid var(--c-warn-text, #f59e0b);border-radius:8px;padding:10px 12px;margin:10px 0;font-size:0.85rem;">
      <strong>⚠ This ship needs ${list.length === 1 ? 'a plugin that is' : 'plugins that are'} no longer on the site</strong>
      <ul style="margin:6px 0 0;padding-left:18px;">${list.map(m => `<li><strong>${h(m.display_name)}</strong>
        ${m.uses.length ? `— used for ${h(m.uses.join(', '))}` : ''}${m.removed_at ? ` · removed ${h(when(m.removed_at))}` : ''}
        ${m.repository ? `<br><a href="${h(m.repository)}" target="_blank" rel="noopener">${h(repoLabel(m.repository))}</a>` : ''}</li>`).join('')}</ul>
      <div style="margin-top:6px;color:var(--c-text-dim);">Install it in Endless Sky to fly this ship, or ask for it to be added back to the site.</div>
    </div>`;
  }

  window.PluginAvailability = { ready, missing, badgeHtml, noticeHtml };
})();

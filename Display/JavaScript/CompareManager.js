'use strict';

// The compare list: single items and groups. CompareDisplay draws it.

window.CompareManager = (() => {

    let _stores = { ship: [], outfit: [] };
    let _activeGroup = 'ship';
    let _nextGroupId = 1;

    // tab → kind of group (ship / outfit). Called by: setActiveTab, add, addGroup

    function _tabToGroup(tab) {
        if (tab === 'ships' || tab === 'variants') return 'ship';
        if (tab === 'outfits') return 'outfit';
        return 'ship';
    }

    // tell the page the list changed
    function _dispatch() {
        window.dispatchEvent(new CustomEvent('compareListChanged', {
            detail: { items: [..._stores[_activeGroup]], groupType: _activeGroup }
        }));
    }

    // id for an item
    function _idOf(item) {
        if (item._isGroup) return '__group__' + item._groupId;
        const tab  = item._compareTab || '';
        const name = String(item.name || '');
        return name + '|' + tab;
    }

    // ── single items ──

    function isInList(item) {
        const id = _idOf(item);
        return _stores.ship.some(i => _idOf(i) === id) ||
               _stores.outfit.some(i => _idOf(i) === id);
    }

    // ship or outfit list? Called by: CompareDisplay
    function getGroupType() { return _activeGroup; }
    // everything in the list. Called by: CompareDisplay
    function getItems()     { return [..._stores[_activeGroup]]; }
    // how many in the list
    function getCount()     { return _stores[_activeGroup].length; }

    // the Data Viewer tab changed (the list holds one kind). Called by: DataViewer.switchTab
    function setActiveTab(tab) {
        const group = _tabToGroup(tab);
        _activeGroup = group;
        _dispatch();
    }

    // add an item
    function add(item, tab) {
        item = Object.assign({}, item, { _compareTab: tab, _isGroup: false });
        const group = _tabToGroup(tab);
        const store = _stores[group];
        if (store.some(i => _idOf(i) === _idOf(item))) return false;
        store.push(item);
        if (group === _activeGroup) _dispatch();
        return true;
    }

    // remove an item
    function remove(item) {
        const id = _idOf(item);
        _stores.ship   = _stores.ship.filter(i => _idOf(i) !== id);
        _stores.outfit = _stores.outfit.filter(i => _idOf(i) !== id);
        _dispatch();
    }

    // empty the list
    function clear() {
        _stores[_activeGroup] = [];
        _dispatch();
    }

    // empty the list and groups
    function clearAll() {
        _stores = { ship: [], outfit: [] };
        _dispatch();
    }

    // add or remove an item. Called by: the compare buttons on cards and the pop-up
    function toggle(item, tab) {
        if (isInList(item)) { remove(item); return false; }
        return add(item, tab);
    }

    // ── groups (members: [{ item, qty }]) ──

    function addGroup(name, members) {
        if (!members || members.length === 0) return null;
        const tab   = members[0].item._compareTab || 'outfits';
        const group = _tabToGroup(tab);
        const entry = {
            _isGroup:  true,
            _groupId:  _nextGroupId++,
            _compareTab: tab,
            name,
            members:   members.map(m => ({ item: m.item, qty: Math.max(1, m.qty || 1) })),
        };
        _stores[group].push(entry);
        if (group === _activeGroup) _dispatch();
        return entry;
    }

    // change a group. Called by: CompareDisplay's group builder
    function updateGroup(groupId, name, members) {
        for (const store of Object.values(_stores)) {
            const idx = store.findIndex(i => i._isGroup && i._groupId === groupId);
            if (idx !== -1) {
                store[idx] = Object.assign({}, store[idx], {
                    name,
                    members: members.map(m => ({ item: m.item, qty: Math.max(1, m.qty || 1) })),
                });
                _dispatch();
                return;
            }
        }
    }

    // remove a group. Called by: CompareDisplay
    function removeGroup(groupId) {
        for (const key of Object.keys(_stores))
            _stores[key] = _stores[key].filter(i => !(i._isGroup && i._groupId === groupId));
        _dispatch();
    }

    // one group by id
    function getGroup(groupId) {
        for (const store of Object.values(_stores)) {
            const g = store.find(i => i._isGroup && i._groupId === groupId);
            if (g) return g;
        }
        return null;
    }

    return {
        isInList, add, remove, clear, clearAll, toggle,
        getItems, getCount, getGroupType, setActiveTab,
        addGroup, updateGroup, removeGroup, getGroup,
    };

})();
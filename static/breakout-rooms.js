'use strict';

const breakoutDialog = /** @type {HTMLDialogElement} */ (document.getElementById('breakout-dialog'));
const breakoutFeedback = document.getElementById('breakout-feedback');
let breakoutInfo = {active: false, current: '', assigned: '', rooms: [], members: []};
let names = ['Salle 1', 'Salle 2'];
/** @type {Map<string, string>} */
const assignments = new Map();

/** @param {string} text */
function breakoutMessage(text) {
    breakoutFeedback.textContent = text;
    breakoutFeedback.hidden = !text;
}

/** @param {string} action @param {any} [value] */
function sendBreakout(action, value) {
    if(!serverConnection?.group)
        return;
    breakoutMessage('');
    serverConnection.groupAction('breakout/' + action, value);
}

function breakoutPeople() {
    return Object.entries(serverConnection?.users || {})
        .filter(([, user]) => !user.permissions.includes('system') && !user.permissions.includes('caption-on-demand'))
        .map(([id, user]) => ({id, name: user.username || 'Anonyme'}))
        .sort((a,b) => a.name.localeCompare(b.name));
}

/**
 * @param {{key:string,title:string}[]} rooms
 * @param {string} current
 */
function breakoutSelect(rooms, current) {
    const select = document.createElement('select');
    select.add(new Option('Salon principal', ''));
    for(const room of rooms)
        select.add(new Option(room.title, room.key));
    select.value = current || '';
    return select;
}

function draftRooms() {
    return names.map((name,i) => ({key: String(i + 1), title: name.trim() || 'Salle ' + (i + 1)}));
}

function renderDraftNames() {
    const container = document.getElementById('breakout-names');
    container.replaceChildren(...names.map((title,i) => {
        const label = document.createElement('label');
        label.className = 'ux-breakout-card';
        const hint = document.createElement('span');
        hint.textContent = 'Salle ' + (i + 1);
        const input = document.createElement('input');
        input.value = title;
        input.required = true;
        input.maxLength = 48;
        input.oninput = () => { names[i] = input.value; };
        input.onchange = renderDraftPeople;
        label.append(hint, input);
        return label;
    }));
}

function renderDraftPeople() {
    const people = breakoutPeople();
    const container = document.getElementById('breakout-draft-members');
    const rooms = draftRooms();
    container.replaceChildren(...people.map(person => {
        const row = document.createElement('label');
        const select = breakoutSelect(rooms, assignments.get(person.id));
        select.onchange = () => assignments.set(person.id, select.value);
        row.append(person.name + (person.id === serverConnection.id ? ' (toi)' : ''), select);
        return row;
    }));
    getButtonElement('breakout-balance').disabled = people.length <= 1;
}

function renderLiveBreakouts() {
    const {rooms, members} = breakoutInfo;
    const roomName = key => rooms.find(room => room.key === key)?.title || 'Salon principal';
    document.getElementById('breakout-cards').replaceChildren(...rooms.map(room => {
        const card = document.createElement('article');
        card.className = 'ux-breakout-card';
        const title = document.createElement('h3');
        title.textContent = room.title;
        const count = document.createElement('p');
        const invited = members.filter(member => member.assignment === room.key).length;
        count.textContent = room.count + ' sur place · ' + invited + ' affecté' + (invited > 1 ? 's' : '');
        card.append(title, count, meetingButton('Visiter', () => sendBreakout('join', room.key)));
        return card;
    }));

    const sorted = [...members].sort((a,b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    const container = document.getElementById('breakout-live-members');
    container.replaceChildren(...sorted.map(person => {
        const row = document.createElement('label');
        row.append(person.name || 'Anonyme');
        if(person.room) {
            const seat = document.createElement('span');
            seat.textContent = roomName(person.room);
            row.append(seat);
        } else {
            const select = breakoutSelect(rooms, person.assignment);
            select.onchange = () => sendBreakout('assign', {id:person.id, room:select.value});
            row.append(select);
        }
        return row;
    }));
}

function renderBreakouts() {
    const op = !!serverConnection?.permissions.includes('op');
    const {active, current, assigned, rooms} = breakoutInfo;
    const offer = active && !current ? rooms.find(room => room.key === assigned) : null;
    const enabled = document.body.dataset.callState === 'connected';
    const shortcut = getButtonElement('breakout-shortcut');
    shortcut.hidden = !enabled || !(current || offer);
    shortcut.textContent = current ? 'Retour au salon principal' : offer ? 'Rejoindre ' + offer.title : '';
    getButtonElement('breakout-toggle').hidden = !enabled || !(op || current || offer);
    document.getElementById('breakout-plan').hidden = !(op && !current && !active);
    document.getElementById('breakout-live').hidden = !(op && !current && active);
    document.getElementById('breakout-guest').hidden = !(current || offer && !op);
    if(breakoutDialog.open && op && !current) {
        if(active)
            renderLiveBreakouts();
        else
            renderDraftPeople();
    }
    if(current || offer) {
        const room = current ? rooms.find(room => room.key === current) : offer;
        document.getElementById('breakout-guest-title').textContent = room?.title || 'Sous-salle';
        document.getElementById('breakout-guest-detail').textContent = current ?
            'Tu es dans cette sous-salle. Tu peux revenir à tout moment.' :
            'Le modérateur t’a affecté à cette salle. Rejoins-la quand tu es prêt.';
        const button = getButtonElement('breakout-guest-action');
        button.hidden = false;
        button.textContent = shortcut.textContent;
    }
}

/** @param {typeof breakoutInfo} state */
function receiveBreakouts(state) {
    const ending = breakoutInfo.active && !state.active;
    breakoutInfo = {...state, rooms:state.rooms || [], members:state.members || []};
    if(ending) {
        assignments.clear();
        breakoutMessage('Les sous-salles sont fermées.');
    }
    renderBreakouts();
}

function resetBreakouts() {
    breakoutInfo = {active: false, current: '', assigned: '', rooms: [], members: []};
    assignments.clear();
    breakoutMessage('');
    if(breakoutDialog.open)
        breakoutDialog.close();
    renderBreakouts();
}

function initializeBreakouts() {
    const toggle = getButtonElement('breakout-toggle');
    toggle.onclick = () => {
        setRoomToolsOpen(false);
        breakoutMessage('');
        breakoutDialog.showModal();
        if(!breakoutInfo.active)
            renderDraftNames();
        renderBreakouts();
    };
    breakoutDialog.addEventListener('close', () => {
        if(document.body.dataset.callState === 'connected')
            getButtonElement('room-tools-toggle').focus();
    });

    const count = getSelectElement('breakout-count');
    count.onchange = () => {
        const length = Number(count.value);
        names = Array.from({length}, (_,i) => names[i] || 'Salle ' + (i + 1));
        for(const [id, key] of assignments) {
            if(Number(key) > length)
                assignments.delete(id);
        }
        renderDraftNames();
        renderDraftPeople();
    };
    getButtonElement('breakout-balance').onclick = () => {
        assignments.clear();
        const attendees = breakoutPeople().filter(person => person.id !== serverConnection.id);
        attendees.forEach((person,i) => assignments.set(person.id, String(i % names.length + 1)));
        renderDraftPeople();
    };
    document.getElementById('breakout-plan').onsubmit = event => {
        event.preventDefault();
        const mapping = {};
        for(const person of breakoutPeople()) {
            const key = assignments.get(person.id);
            if(key)
                mapping[person.id] = key;
        }
        sendBreakout('launch', {rooms:names, assignments:mapping});
    };
    getButtonElement('breakout-recall').onclick = () => sendBreakout('close');
    const move = () => {
        if(breakoutInfo.current)
            sendBreakout('return');
        else if(breakoutInfo.active && breakoutInfo.assigned)
            sendBreakout('join', breakoutInfo.assigned);
    };
    getButtonElement('breakout-shortcut').onclick = move;
    getButtonElement('breakout-guest-action').onclick = move;
}

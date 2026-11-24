'use strict';

const meetingDialog = /** @type {HTMLDialogElement} */ (document.getElementById('meeting-dialog'));
const meetingNotes = /** @type {HTMLTextAreaElement} */ (document.getElementById('meeting-notes'));
let notesVersion = 0;
let notesDirty = false;
let savingNotes = false;
let notesConflict = false;
let lastNotes;
const meetingFeedback = document.getElementById('meeting-feedback');

/** @param {string} action @param {Record<string,any>} [value] */
function sendMeetingAction(action, value) {
    meetingFeedback.textContent = '';
    serverConnection?.groupAction('meeting/' + action, value);
}

/**
 * @param {string} text
 * @param {() => void} click
 */
function meetingButton(text, click) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ux-button';
    button.textContent = text;
    button.onclick = click;
    return button;
}

/** @param {any} state */
function reflectMeetingState(state) {
    if(!state)
        return;
    const op = serverConnection.permissions.includes('op');
    lastNotes = {text: state.notes, version: state.notesVersion};
    const canContribute = op || serverConnection.permissions.includes('message');
    const poll = state.poll;
    const pollView = document.getElementById('meeting-poll');
    pollView.replaceChildren();
    if(poll) {
        const title = document.createElement('h3');
        title.textContent = poll.question;
        pollView.appendChild(title);
        for(const [index, option] of poll.options.entries()) {
            const label = option + (poll.counts ? ' · ' + poll.counts[index] : '');
            const vote = meetingButton(label, () => sendMeetingAction('poll-vote', {id: poll.id, option: index}));
            vote.disabled = poll.closed || !canContribute;
            vote.setAttribute('aria-pressed', String(poll.vote === index));
            pollView.appendChild(vote);
        }
        if(op && !poll.closed)
            pollView.appendChild(meetingButton('Publier le résultat', () => sendMeetingAction('poll-close', {id: poll.id})));
    } else {
        pollView.textContent = 'Aucun sondage.';
    }
    document.getElementById('meeting-create-poll').hidden = !op || !!poll && !poll.closed;
    document.getElementById('meeting-question-form').hidden = !canContribute;
    const questions = document.getElementById('meeting-questions');
    questions.replaceChildren();
    for(const q of [...(state.questions || [])].sort((a,b) => Number(a.done) - Number(b.done) || b.votes - a.votes || a.id - b.id)) {
        const row = document.createElement('li');
        row.textContent = (q.author || 'Anonyme') + ' — ' + q.text;
        const actions = document.createElement('div');
        actions.className = 'ux-dialog-actions';
        if(q.done) {
            actions.textContent = 'Traitée';
        } else {
            if(canContribute) {
                const vote = meetingButton('Soutenir · ' + q.votes, () => sendMeetingAction('question-vote', {id: q.id}));
                vote.setAttribute('aria-pressed', String(q.voted));
                actions.appendChild(vote);
            }
            if(q.own)
                actions.appendChild(meetingButton('En parler', () => {
                    setHandRaised(true, q.text);
                    meetingDialog.close();
                    if(currentCallPanel !== 'participants')
                        selectCallPanel('participants');
                }));
            if(op)
                actions.appendChild(meetingButton('Marquer traitée', () => sendMeetingAction('question-done', {id: q.id})));
        }
        row.appendChild(actions);
        questions.appendChild(row);
    }

    meetingNotes.readOnly = !op;
    getButtonElement('meeting-save').hidden = !op;
    if(!notesDirty || savingNotes && state.notes === meetingNotes.value.trim()) {
        notesVersion = state.notesVersion;
        meetingNotes.value = state.notes;
        notesDirty = false;
        savingNotes = false;
    }
}

/** @param {string} message */
function showMeetingError(message) {
    savingNotes = false;
    if(message === 'notes have changed') {
        notesConflict = true;
        meetingFeedback.textContent = 'Les notes ont changé entre-temps. Copie ton brouillon, puis rouvre le panneau pour reprendre la dernière version.';
    } else if(message === 'invalid poll option') {
        meetingFeedback.textContent = 'Chaque réponse du sondage doit être différente.';
    } else {
        meetingFeedback.textContent = 'Action indisponible. Vérifie l’état du sondage, de la question ou des notes.';
    }
}

function initializeMeetingTools() {
    getButtonElement('meeting-toggle').onclick = () => {
        setRoomToolsOpen(false);
        meetingFeedback.textContent = '';
        meetingDialog.showModal();
    };
    meetingDialog.addEventListener('close', () => {
        if(notesConflict && lastNotes) {
            meetingNotes.value = lastNotes.text;
            notesVersion = lastNotes.version;
            notesConflict = false;
            notesDirty = false;
        }
        if(document.body.dataset.callState === 'connected')
            getButtonElement('room-tools-toggle').focus();
    });
    document.getElementById('meeting-create-poll').onsubmit = event => {
        event.preventDefault();
        const question = getInputElement('poll-question').value.trim();
        const options = /** @type {HTMLTextAreaElement} */ (document.getElementById('poll-options')).value
            .split('\n').map(line => line.trim()).filter(Boolean);
        if(options.length < 2 || options.length > 6 || options.some(text => text.length > 100)) {
            meetingFeedback.textContent = 'Ajoute entre deux et six réponses de 100 caractères maximum.';
            return;
        }
        sendMeetingAction('poll-open', {question, options});
    };
    document.getElementById('meeting-question-form').onsubmit = event => {
        event.preventDefault();
        const field = getInputElement('meeting-question-text');
        const text = field.value.trim();
        if(text) {
            sendMeetingAction('question-add', {text});
            field.value = '';
        }
    };
    meetingNotes.oninput = () => { notesDirty = true; };
    getButtonElement('meeting-save').onclick = () => {
        savingNotes = true;
        sendMeetingAction('notes-save', {version: notesVersion, text: meetingNotes.value});
    };
    getButtonElement('meeting-copy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(meetingNotes.value);
            meetingFeedback.textContent = 'Notes copiées.';
        } catch(e) {
            meetingNotes.focus();
            meetingNotes.select();
        }
    };
}

function resetMeetingTools() {
    notesVersion = 0;
    notesDirty = false;
    savingNotes = false;
    notesConflict = false;
    lastNotes = null;
    meetingNotes.value = '';
    document.getElementById('meeting-poll').replaceChildren();
    document.getElementById('meeting-questions').replaceChildren();
    reflectLobbyEnabled(false);
    reflectWaitingGuests([]);
    if(meetingDialog.open)
        meetingDialog.close();
}

/** @param {boolean} pending */
function setWaitingRoom(pending) {
    document.getElementById('waiting-panel').hidden = !pending;
    document.getElementById('loginform').hidden = pending;
    if(pending) {
        document.body.dataset.callState = 'waiting';
        updateCallStatus();
        getButtonElement('waiting-cancel').focus();
    }
}

/** @param {unknown} enabled */
function reflectLobbyEnabled(enabled) {
    const op = serverConnection?.permissions.includes('op');
    document.getElementById('lobby-controls').hidden = !op && !groupStatus.memberAdmission;
    document.getElementById('lobby-toggle').hidden = !op;
    getInputElement('lobby-enabled').checked = enabled === true;
    if(!op && !groupStatus.memberAdmission)
        reflectWaitingGuests([]);
}

/** @param {{id:string,username:string}[]} entries */
function reflectWaitingGuests(entries) {
    const list = document.getElementById('lobby-list');
    list.replaceChildren();
    for(const entry of entries) {
        const row = document.createElement('li');
        const username = document.createElement('span');
        username.textContent = entry.username || 'Anonyme';
        row.append(username,
            meetingButton('Admettre', () => serverConnection.groupAction('lobby-admit', entry.id)),
            meetingButton('Refuser', () => serverConnection.groupAction('lobby-deny', entry.id)));
        list.appendChild(row);
    }
    const summary = getButtonElement('lobby-summary');
    summary.hidden = entries.length === 0;
    summary.textContent = entries.length + ' en attente';
}

function initializeLobby() {
    getInputElement('lobby-enabled').onchange = () => serverConnection.groupAction(
        'setdata', {requireAdmission: getInputElement('lobby-enabled').checked},
    );
    getButtonElement('lobby-summary').onclick = () => {
        if(currentCallPanel !== 'participants')
            selectCallPanel('participants');
    };
    getButtonElement('waiting-cancel').onclick = () => {
        presentRequested = null;
        serverConnection.close();
    };
}

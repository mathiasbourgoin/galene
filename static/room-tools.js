'use strict';

const toolsPanel = document.getElementById('room-tools');
const stage = document.getElementById('presentation-stage');
let pointerEnabled = false;
let lastPointerSent = -Infinity;
let boardUrl = '';
let boardPresented = false;
let pointerTimeout;
const boardStage = document.getElementById('board-stage');
const boardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById('board-frame'));

/** @param {boolean} open */
function setRoomToolsOpen(open) {
    toolsPanel.hidden = !open;
    document.getElementById('room-tools-toggle').setAttribute('aria-expanded', String(open));
}

/** Returns the group-level receive preference, including the local bandwidth override. */
function effectiveReceiveMode() {
    const settings = getSettings();
    if(settings.lowBandwidth)
        return settings.keepScreenshare === false ? 'audio' : 'screenshare';
    return settings.request;
}

function reflectBandwidthMode() {
    const settings = getSettings();
    document.getElementById('low-bandwidth').setAttribute('aria-pressed', String(!!settings.lowBandwidth));
    document.getElementById('keep-share-row').hidden = !settings.lowBandwidth;
    getInputElement('keep-share').checked = settings.keepScreenshare !== false;
    getSelectElement('requestselect').disabled = !!settings.lowBandwidth;
    updateCallStatus();
}

function requestRoomMedia() {
    if(!serverConnection?.group)
        return;
    for(const stream of Object.values(serverConnection.down)) {
        if(stream.userdata.requested?.low) {
            delete stream.userdata.requested.low;
            stream.request(null);
        }
    }
    serverConnection.request(mapRequest(effectiveReceiveMode()));
    scheduleReconsiderDownRate();
}

/** @param {unknown} value */
function excalidrawRoom(value) {
    if(typeof value !== 'string')
        return '';
    try {
        const url = new URL(value);
        if(url.origin === 'https://excalidraw.com' && !url.username && !url.password &&
           url.pathname === '/' && !url.search && /^#room=[a-zA-Z0-9_-]+,[a-zA-Z0-9_-]{22}$/.test(url.hash))
            return url.href;
    } catch(e) {
        // An invalid URL is handled by the form submitting it.
    }
    return '';
}

/** @param {unknown} value @param {boolean} [presented] */
function reflectSharedBoard(value, presented) {
    const next = excalidrawRoom(value);
    const changed = next !== boardUrl;
    boardUrl = next;
    const canShare = serverConnection?.permissions.includes('op');
    const status = document.getElementById('board-status');
    document.getElementById('board-open').hidden = !boardUrl;
    document.getElementById('board-present').hidden = !boardUrl || !canShare;
    document.getElementById('board-present').textContent = presented ? 'Arrêter la présentation' : 'Afficher pour tout le salon';
    document.getElementById('board-form').hidden = !canShare;
    document.getElementById('board-clear').hidden = !boardUrl;
    if(changed)
        getInputElement('board-url').value = '';
    status.textContent = boardUrl ? 'Un tableau est partagé dans ce salon.' : 'Aucun tableau partagé pour le moment.';
    if(!boardUrl || boardPresented !== !!presented || (changed && !boardStage.hidden))
        showBoardStage(!!boardUrl && (!!presented || changed && !boardStage.hidden));
    boardPresented = !!presented;
}

/** @param {boolean} open */
function showBoardStage(open) {
    if(!boardUrl)
        open = false;
    boardStage.hidden = !open;
    if(open) {
        pointerEnabled = false;
        if(boardFrame.getAttribute('src') !== boardUrl)
            boardFrame.src = boardUrl;
        /** @type {HTMLAnchorElement} */ (document.getElementById('board-popout')).href = boardUrl;
    }
    if(!boardUrl)
        boardFrame.removeAttribute('src');
    if(serverConnection) {
        showVideo();
        resizePeers();
    }
}

function resetRoomTools() {
    setRoomToolsOpen(false);
    pointerEnabled = false;
    lastPointerSent = -Infinity;
    clearSharePointer();
    reflectSharedBoard(null);
    getInputElement('board-url').value = '';
    for(const id of ['board-dialog', 'invite-dialog']) {
        const dialog = /** @type {HTMLDialogElement} */ (document.getElementById(id));
        if(dialog.open)
            dialog.close();
    }
}

function updatePresentationLayout() {
    const tiles = document.getElementById('participant-tiles');
    const peers = document.getElementById('peers');
    const current = stage.querySelector(':scope > .peer');
    const isShare = '.peer[data-share-owner]:not(.peer-hidden):not(.ux-audio-only)';
    const own = Array.from(peers.querySelectorAll(isShare)).find(
        peer => peer.getAttribute('data-share-owner') === serverConnection.id,
    );
    if(!own)
        pointerEnabled = false;
    const pointerButton = document.getElementById('pointer-toggle');
    pointerButton.hidden = !own || !serverConnection.permissions.includes('message');
    if(pointerButton.hidden)
        pointerEnabled = false;
    pointerButton.setAttribute('aria-pressed', String(pointerEnabled));

    const chosen = !boardStage.hidden ? null : pointerEnabled ? own :
        current?.matches(isShare) ? current : tiles.querySelector(isShare);
    if(current !== chosen) {
        clearSharePointer();
        if(current) {
            current.classList.remove('peer-pointer-active');
            for(const mark of current.querySelectorAll('.ux-annotation'))
                mark.remove();
            tiles.appendChild(current);
        }
        if(chosen)
            stage.appendChild(chosen);
    }
    chosen?.classList.toggle('peer-pointer-active', pointerEnabled);
    const showingStage = !!chosen || !boardStage.hidden;
    stage.hidden = !showingStage;
    peers.classList.toggle('ux-presenting', showingStage);
    refreshAnnotations();
    return showingStage;
}

/** @param {HTMLElement} peer */
function shareVideoBounds(peer) {
    const media = peer.querySelector('video.media');
    if(!(media instanceof HTMLVideoElement) || !media.videoWidth || !media.videoHeight)
        return null;
    const bounds = media.getBoundingClientRect();
    const scale = Math.min(bounds.width / media.videoWidth, bounds.height / media.videoHeight);
    if(!scale)
        return null;
    const width = media.videoWidth * scale;
    const height = media.videoHeight * scale;
    return {x: bounds.x + (bounds.width - width) / 2,
            y: bounds.y + (bounds.height - height) / 2, width, height};
}

function clearSharePointer() {
    clearTimeout(pointerTimeout);
    stage.querySelector('.ux-share-pointer')?.remove();
}

/**
 * @param {string} source
 * @param {any} point
 */
function receiveSharePointer(source, point) {
    const peer = /** @type {HTMLElement} */ (stage.querySelector(':scope > .peer'));
    if(!source || peer?.dataset.shareOwner !== source)
        return;
    if(point === null) {
        clearSharePointer();
        return;
    }
    if(!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
       point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
        return;
    const frame = shareVideoBounds(peer);
    if(!frame)
        return;
    let mark = /** @type {HTMLElement} */ (peer.querySelector('.ux-share-pointer'));
    if(!mark) {
        mark = document.createElement('span');
        mark.className = 'ux-share-pointer';
        mark.setAttribute('aria-hidden', 'true');
        peer.appendChild(mark);
    }
    const bounds = peer.getBoundingClientRect();
    mark.style.left = (frame.x - bounds.x + point.x * frame.width) + 'px';
    mark.style.top = (frame.y - bounds.y + point.y * frame.height) + 'px';
    clearTimeout(pointerTimeout);
    pointerTimeout = setTimeout(clearSharePointer, 800);
}

/** @param {PointerEvent} event */
function sendSharePointer(event) {
    if(!pointerEnabled || !(event.target instanceof HTMLVideoElement))
        return;
    const peer = /** @type {HTMLElement} */ (stage.querySelector(':scope > .peer'));
    if(peer?.dataset.shareOwner !== serverConnection.id)
        return;
    const now = performance.now();
    if(now - lastPointerSent < 50)
        return;
    const frame = shareVideoBounds(peer);
    if(!frame)
        return;
    const x = (event.clientX - frame.x) / frame.width;
    const y = (event.clientY - frame.y) / frame.height;
    if(x < 0 || x > 1 || y < 0 || y > 1)
        return;
    lastPointerSent = now;
    serverConnection.userMessage('share-pointer', '', {x, y}, true);
    receiveSharePointer(serverConnection.id, {x, y});
}

function initializeRoomTools() {
    const toggle = getButtonElement('room-tools-toggle');
    toggle.onclick = () => {
        const open = toolsPanel.hidden;
        setReactionPicker(false);
        setRoomToolsOpen(open);
        if(open)
            getButtonElement('openside').focus();
    };
    document.addEventListener('click', event => {
        const target = /** @type {Node} */ (event.target);
        if(!toolsPanel.hidden && !toolsPanel.contains(target) && !toggle.contains(target))
            setRoomToolsOpen(false);
    });
    getButtonElement('low-bandwidth').onclick = () => {
        updateSettings({lowBandwidth: !getSettings().lowBandwidth});
        reflectBandwidthMode();
        requestRoomMedia();
    };
    getInputElement('keep-share').onchange = function() {
        if(!(this instanceof HTMLInputElement))
            return;
        updateSettings({keepScreenshare: this.checked});
        requestRoomMedia();
    };
    const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('board-dialog'));
    getButtonElement('board-toggle').onclick = () => {
        setRoomToolsOpen(false);
        dialog.showModal();
    };
    dialog.addEventListener('close', () => {
        if(document.body.dataset.callState === 'connected')
            toggle.focus();
    });
    document.getElementById('board-form').onsubmit = event => {
        event.preventDefault();
        if(!serverConnection?.permissions.includes('op'))
            return;
        const input = getInputElement('board-url');
        const link = excalidrawRoom(input.value.trim());
        if(!link) {
            document.getElementById('board-status').textContent = 'Colle un lien de collaboration excalidraw.com.';
            input.focus();
            return;
        }
        serverConnection.groupAction('setdata', {sharedBoard: link});
        input.value = '';
    };
    getButtonElement('board-clear').onclick = () => {
        if(serverConnection?.permissions.includes('op'))
            serverConnection.groupAction('setdata', {sharedBoard: null, presentBoard: null});
    };
    getButtonElement('board-open').onclick = () => {
        dialog.close();
        showBoardStage(true);
    };
    getButtonElement('board-present').onclick = () => {
        if(!boardUrl || !serverConnection?.permissions.includes('op'))
            return;
        serverConnection.groupAction('setdata', {presentBoard: !boardPresented});
        dialog.close();
    };
    getButtonElement('board-close-stage').onclick = () => {
        showBoardStage(false);
        getButtonElement('room-tools-toggle').focus();
    };
    getButtonElement('pointer-toggle').onclick = () => {
        if(!boardStage.hidden)
            showBoardStage(false);
        pointerEnabled = !pointerEnabled;
        if(pointerEnabled)
            getSelectElement('annotation-mode').value = '';
        if(!pointerEnabled) {
            clearSharePointer();
            serverConnection.userMessage('share-pointer', '', null, true);
        }
        setRoomToolsOpen(false);
        resizePeers();
        toggle.focus();
    };
    stage.addEventListener('pointermove', sendSharePointer);
    stage.addEventListener('pointerdown', sendSharePointer);
}

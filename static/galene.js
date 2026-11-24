// Copyright (c) 2020 by Juliusz Chroboczek.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

/**
 * The name of the group that we join.
 *
 * @type {string}
 */
let group;

/**
 * The connection to the server.
 *
 * @type {ServerConnection}
 */
let serverConnection;

/**
 * The group status.  This is set twice, once over HTTP in the start
 * function in order to obtain the WebSocket address, and a second time
 * after joining.
 *
 * @type {Record<string,any>}
 */
let groupStatus = {};

/**
 * True if we need to request a password.
 *
 * @type {boolean}
 */
let pwAuth = false;

/**
 * The token we use to login.  This is erased as soon as possible.
 *
 * @type {string}
 */
let token = null;

/**
 * The state of the login automaton.
 *
 * @type {"probing" | "need-username" | "success"}
 */
let probingState = null;

/**
 * getElementById, then assert that the result is an HTMLSelectElement.
 *
 * @param {string} id
 */
function getSelectElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLSelectElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLInputElement.
 *
 * @param {string} id
 */
function getInputElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLInputElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLButtonElement.
 *
 * @param {string} id
 */
function getButtonElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLButtonElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * Ensure that the UI reflects the stored settings.
 */
function reflectSettings() {
    let settings = getSettings();
    let store = false;

    // Apply the new defaults to tabs that already stored the old defaults.
    if(!settings.privacyDefaultsApplied) {
        settings.privacyDefaultsApplied = true;
        settings.displayAll = true;
        if(!settings.filter)
            settings.filter = 'background-blur';
        store = true;
    }

    setLocalMute(settings.localMute);

    let videoselect = getSelectElement('videoselect');
    if(!settings.hasOwnProperty('video') ||
       !selectOptionAvailable(videoselect, settings.video)) {
        settings.video = selectOptionDefault(videoselect);
        store = true;
    }
    videoselect.value = settings.video;

    let audioselect = getSelectElement('audioselect');
    if(!settings.hasOwnProperty('audio') ||
       !selectOptionAvailable(audioselect, settings.audio)) {
        settings.audio = selectOptionDefault(audioselect);
        store = true;
    }
    audioselect.value = settings.audio;

    if(!settings.hasOwnProperty('filter') ||
       (settings.filter === 'background-image' && !backgroundImage)) {
        settings.filter = 'background-blur';
        store = true;
    }
    getSelectElement('filterselect').value = settings.filter;

    if(settings.hasOwnProperty('request')) {
        getSelectElement('requestselect').value = settings.request;
    } else {
        settings.request = getSelectElement('requestselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('send')) {
        getSelectElement('sendselect').value = settings.send;
    } else {
        settings.send = getSelectElement('sendselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('simulcast')) {
        getSelectElement('simulcastselect').value = settings.simulcast
    } else {
        settings.simulcast = getSelectElement('simulcastselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('blackboardMode')) {
        getInputElement('blackboardbox').checked = settings.blackboardMode;
    } else {
        settings.blackboardMode = getInputElement('blackboardbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('mirrorView')) {
        getInputElement('mirrorbox').checked = settings.mirrorView;
    } else {
        settings.mirrorView = getInputElement('mirrorbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('activityDetection')) {
        getInputElement('activitybox').checked = settings.activityDetection;
    } else {
        settings.activityDetection = getInputElement('activitybox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('displayAll')) {
        getInputElement('displayallbox').checked = settings.displayAll;
    } else {
        settings.displayAll = getInputElement('displayallbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('preprocessing')) {
        getInputElement('preprocessingbox').checked = settings.preprocessing;
    } else {
        settings.preprocessing = getInputElement('preprocessingbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('hqaudio')) {
        getInputElement('hqaudiobox').checked = settings.hqaudio;
    } else {
        settings.hqaudio = getInputElement('hqaudiobox').checked;
        store = true;
    }

    if(store)
        storeSettings(settings);
    reflectBandwidthMode();
}

/**
 * Conditionally hide the video pane.  If force is true, hide it even if
 * there are videos.
 *
 * @param {boolean} [force]
 */
function hideVideo(force) {
    if(!force && (document.querySelector('#peers .peer:not(.peer-hidden)') || !boardStage.hidden))
        return;
    setVisibility('video-container', false);
    document.getElementById('empty-room').hidden =
        document.body.dataset.callState !== 'connected';
    scheduleReconsiderDownRate();
}

/**
 * Show the video pane.
 */
function showVideo() {
    let hasmedia = !!document.querySelector('#peers .peer:not(.peer-hidden)') || !boardStage.hidden;
    setVisibility('video-container', hasmedia);
    document.getElementById('empty-room').hidden = hasmedia ||
        document.body.dataset.callState !== 'connected';
    scheduleReconsiderDownRate();
}

/**
 * Returns true if we are running on Safari.
 */
function isSafari() {
    let ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('safari') >= 0 && ua.indexOf('chrome') < 0;
}

/**
 * Returns true if we are running on Firefox.
 */
function isFirefox() {
    let ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('firefox') >= 0;
}

/**
 * setConnected is called whenever we connect or disconnect to the server.
 *
 * @param{boolean} connected
 */
function setConnected(connected) {
    let userbox = document.getElementById('profile');
    let connectionbox = document.getElementById('login-container');
    document.body.dataset.callState = connected ? 'connected' : 'lobby';
    document.getElementById(connected ? 'call-video-effects' : 'lobby-video-effects')
        .appendChild(document.getElementById('filterform'));
    document.getElementById('call-controls').hidden = !connected;
    monitorCallDiagnostics(connected);
    setWaitingRoom(false);
    if(connected) {
        clearChat();
        let testCamera =  /** @type{HTMLDetailsElement} */
            (document.getElementById('test-camera'));
        // this causes the camera test to stop running
        testCamera.open = false;
        userbox.classList.remove('invisible');
        connectionbox.classList.add('invisible');
        displayUsername();
        window.onresize = function(e) {
            scheduleReconsiderDownRate();
        }
    } else {
        resetBreakouts();
        resetMeetingTools();
        resetRoomTools();
        resetReactions();
        renderSpeakingQueue([]);
        updateCameraOffTiles();
        userbox.classList.add('invisible');
        connectionbox.classList.remove('invisible');
        hideVideo();
        selectCallPanel(null);
        document.getElementById('invite-button').hidden = true;
        /** @type {HTMLDialogElement} */(document.getElementById('invite-dialog')).close();
        setInvitationPending(false);
        window.onresize = null;
    }
    updateCallStatus();
    renderBreakouts();
}

/**
 * Called when we connect to the server.
 *
 * @this {ServerConnection}
 */
async function gotConnected() {
    await join();
}

/**
 * Sets the href field of the "change password" link.
 *
 * @param {string} username
 */
function setChangePassword(username) {
    let s = document.getElementById('chpwspan');
    let a = s.children[0];
    if(!(a instanceof HTMLAnchorElement))
        throw new Error('Bad type for chpwspan');
    if(username) {
        a.href = `/change-password.html?group=${encodeURIComponent(group)}&username=${encodeURIComponent(username)}`;
        a.target = '_blank';
        s.classList.remove('invisible');
    } else {
        a.href = null;
        s.classList.add('invisible');
    }
}

/**
 * Join a group.
 */
async function join() {
    let username = getInputElement('username').value.trim();
    let credentials;
    if(token) {
        pwAuth = false;
        credentials = {
            type: 'token',
            token: token,
        };
        switch(probingState) {
        case null:
            // when logging in with a token, we need to give the user
            // a chance to interact with the page in order to enable
            // autoplay.  Probe the group first in order to determine if
            // we need a username.  We should really extend the protocol
            // to have a simpler protocol for probing.
            probingState = 'probing';
            username = null;
            break;
        case 'need-username':
        case 'success':
            probingState = null;
            break
        default:
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
            break;
        }
    } else {
        if(probingState !== null) {
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
        }
        let pw = getInputElement('password').value;
        getInputElement('password').value = '';
        if(!groupStatus.authServer) {
            pwAuth = true;
            credentials = pw;
        } else {
            pwAuth = false;
            credentials = {
                type: 'authServer',
                authServer: groupStatus.authServer,
                location: location.href,
                password: pw,
            };
        }
    }

    try {
        await serverConnection.join(group, username, credentials);
    } catch(e) {
        console.error(e);
        displayError(e);
        serverConnection.close();
    }
}

/**
 * @this {ServerConnection}
 */
function onPeerConnection() {
    if(!getSettings().forceRelay)
        return null;
    let old = this.rtcConfiguration;
    /** @type {RTCConfiguration} */
    let conf = {};
    for(let key in old)
        conf[key] = old[key];
    conf.iceTransportPolicy = 'relay';
    return conf;
}

/**
 * @this {ServerConnection}
 * @param {number} code
 * @param {string} reason
 */
function gotClose(code, reason) {
    if(this !== serverConnection)
        return;
    closeUpMedia();
    closeSafariStream();
    let wasInCall = document.body.dataset.callState === 'connected';
    setConnected(false);
    if(code !== 1000) {
        console.warn('Socket close', code, reason);
        setJoinError(wasInCall ? 'Connexion interrompue. Tu peux rejoindre le salon à nouveau.' :
                     'Connexion au salon impossible. Réessaie dans un instant.');
    }
    if(wasInCall)
        document.getElementById('join-title').focus();
}

/**
 * @this {ServerConnection}
 * @param {Stream} c
 */
function gotDownStream(c) {
    c.onclose = function(replace) {
        if(!replace)
            delMedia(c.localId);
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    c.ondowntrack = function(track, transceiver, stream) {
        setMedia(c);
    };
    c.onnegotiationcompleted = function() {
        resetMedia(c);
    }
    c.onstatus = function(status) {
        setMediaStatus(c);
        updateCallStatus();
    };
    c.onstats = gotDownStats;
    if(getSettings().activityDetection)
        c.setStatsInterval(activityDetectionInterval);

    setMedia(c);
}

// Store current browser viewport height in css variable
function setViewportHeight() {
    document.documentElement.style.setProperty(
        '--vh', `${window.innerHeight/100}px`,
    );
    showVideo();
    // Ajust video component size
    resizePeers();
}

// On resize and orientation change, we update viewport height
addEventListener('resize', setViewportHeight);
addEventListener('orientationchange', setViewportHeight);

getButtonElement('presentbutton').onclick = async function(e) {
    e.preventDefault();
    let media = localMediaState();
    await switchLocalMedia(media.audio, !media.video);
};

/**
 * @typedef {{audio: boolean, video: boolean, micOn: boolean}} LocalMediaState
 */

/** @returns {LocalMediaState} */
function localMediaState() {
    let camera = findUpMedia('camera');
    let stream = camera && camera.stream;
    let audio = stream && stream.getAudioTracks().find(t => t.readyState === 'live');
    let video = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
    return {audio: !!audio, video: !!video, micOn: !!audio && audio.enabled};
}

let changingMedia = false;

/**
 * Replace the published camera stream using the existing Galène pipeline.
 *
 * @param {boolean} audio
 * @param {boolean} video
 */
async function switchLocalMedia(audio, video) {
    if(changingMedia || !serverConnection?.group ||
       serverConnection.permissions.indexOf('present') < 0)
        return;
    changingMedia = true;
    setButtonsVisibility();
    try {
        let camera = findUpMedia('camera');
        if(camera && camera.stream.getVideoTracks().length && !video) {
            if(audio) {
                // Keep the current microphone live and release the camera.
                await removeFilter(camera);
                if(!camera.sc)
                    return;
                for(let track of camera.stream.getVideoTracks()) {
                    track.stop();
                    camera.stream.removeTrack(track);
                }
                delete camera.userdata.filterDefinition;
                await replaceUpStream(camera);
            } else {
                camera.close();
            }
        } else {
            await addLocalMedia(camera?.localId, {audio, video});
        }
    } finally {
        changingMedia = false;
        setButtonsVisibility();
    }
}

/**
 * @param {string} message
 */
function setJoinError(message) {
    let target = document.getElementById('join-error');
    target.textContent = message;
    target.hidden = !message;
}

function updateCallStatus() {
    let state = document.body.dataset.callState;
    let label = 'Avant l’appel';
    let canRetryMedia = false;
    if(state === 'connecting') {
        label = 'Connexion au salon…';
    } else if(state === 'waiting') {
        label = 'En salle d’attente';
    } else if(state === 'connected') {
        let streams = [...Object.keys(serverConnection.up).map(id => serverConnection.up[id]),
                       ...Object.keys(serverConnection.down).map(id => serverConnection.down[id])];
        let interrupted = !navigator.onLine || streams.some(c =>
            ['disconnected', 'failed'].indexOf(c.pc?.iceConnectionState) >= 0);
        canRetryMedia = interrupted && navigator.onLine;
        let connecting = streams.some(c =>
            ['new', 'checking'].indexOf(c.pc?.iceConnectionState) >= 0);
        label = interrupted ? 'Connexion média interrompue' :
               connecting ? 'Connexion média en cours…' : 'En réunion';
        if(!interrupted && !connecting && getSettings().lowBandwidth)
            label = 'En réunion · Connexion faible';
    }
    let status = document.getElementById('connection-status');
    if(status.textContent !== label)
        status.textContent = label;
    document.getElementById('media-retry').hidden = !canRetryMedia;
    document.getElementById('connectbutton').toggleAttribute('disabled', state === 'connecting');
}

window.addEventListener('online', updateCallStatus);
window.addEventListener('offline', updateCallStatus);
getButtonElement('media-retry').onclick = () => {
    renegotiateStreams();
    document.getElementById('connection-status').textContent = 'Relance de la connexion média…';
};

/**
 * @param {string} id
 * @param {boolean} visible
 */
function setVisibility(id, visible) {
    let elt = document.getElementById(id);
    if(visible)
        elt.classList.remove('invisible');
    else
        elt.classList.add('invisible');
}

/**
 * Shows and hides various UI elements depending on the protocol state.
 */
function setButtonsVisibility() {
    let permissions = serverConnection?.permissions || [];
    let canWebrtc = typeof RTCPeerConnection !== 'undefined';
    let canPresent = canWebrtc && !!navigator.mediaDevices?.getUserMedia &&
        permissions.indexOf('present') >= 0;
    let canShare = canWebrtc && !!navigator.mediaDevices?.getDisplayMedia &&
        permissions.indexOf('present') >= 0;
    let media = localMediaState();
    let sharing = !!findUpMedia('screenshare');
    setVisibility('mediaoptions', canPresent);
    setVisibility('sendform', canPresent);
    setVisibility('simulcastform', canPresent);
    getButtonElement('presentbutton').disabled = !canPresent || changingMedia;
    getButtonElement('mutebutton').disabled = !canPresent || changingMedia;
    getButtonElement('sharebutton').disabled = !canShare && !sharing;
    getButtonElement('presentbutton').setAttribute('aria-pressed', String(media.video));
    getButtonElement('mutebutton').setAttribute('aria-pressed', String(media.micOn));
    getButtonElement('sharebutton').setAttribute('aria-pressed', String(sharing));
    document.getElementById('camera-label').textContent = media.video ? 'Caméra active' : 'Caméra coupée';
    document.getElementById('mic-label').textContent = media.micOn ? 'Micro actif' : 'Micro coupé';
    document.getElementById('share-label').textContent = sharing ? 'Arrêter le partage' : 'Partager l’écran';
    document.getElementById('invite-button').hidden = permissions.indexOf('token') < 0 ||
        document.body.dataset.callState !== 'connected';
    const reactions = getButtonElement('reactions-toggle');
    reactions.hidden = !permissions.includes('message');
    if(reactions.hidden)
        setReactionPicker(false);
    updateCallStatus();
}

/**
 * Sets the local mute state.  If reflect is true, updates the stored settings.
 *
 * @param {boolean} mute
 * @param {boolean} [reflect]
 */
function setLocalMute(mute, reflect) {
    muteLocalTracks(mute);
    let button = document.getElementById('mutebutton');
    let icon = button.querySelector("span .fas");
    if(mute){
        icon.classList.add('fa-microphone-slash');
        icon.classList.remove('fa-microphone');
        button.classList.add('muted');
    } else {
        icon.classList.remove('fa-microphone-slash');
        icon.classList.add('fa-microphone');
        button.classList.remove('muted');
    }
    if(reflect)
        updateSettings({localMute: mute});
    setButtonsVisibility();
}

getSelectElement('videoselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({video: this.value});
    replaceCameraStream();
};

getSelectElement('audioselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({audio: this.value});
    replaceCameraStream();
};

getInputElement('mirrorbox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({mirrorView: this.checked});
    // no need to reopen the camera
    replaceUpStreams('camera');
};

getInputElement('blackboardbox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({blackboardMode: this.checked});
    replaceCameraStream();
};

getInputElement('preprocessingbox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({preprocessing: this.checked});
    replaceCameraStream();
};

getInputElement('hqaudiobox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({hqaudio: this.checked});
    replaceCameraStream();
};

getButtonElement('mutebutton').onclick = async function(e) {
    e.preventDefault();
    let media = localMediaState();
    if(media.audio) {
        setLocalMute(media.micOn, true);
    } else {
        await switchLocalMedia(true, media.video);
        if(localMediaState().audio)
            setLocalMute(false, true);
    }
};

getButtonElement('sharebutton').onclick = async function(e) {
    e.preventDefault();
    if(findUpMedia('screenshare')) {
        closeUpMedia('screenshare');
        setButtonsVisibility();
        return;
    }
    getButtonElement('sharebutton').disabled = true;
    try {
        await addShareMedia();
    } finally {
        setButtonsVisibility();
    }
};

let cameraFilterUpdate = Promise.resolve();

/** @param {string} name */
async function applyCameraFilter(name) {
    updateSettings({filter: name});
    cameraFilterUpdate = cameraFilterUpdate.then(async () => {
        if(getSettings().filter !== name)
            return;

        let c = findUpMedia('camera');
        let filter = filters[name];
        if(!c || !c.stream?.getVideoTracks().length) {
            if(cameraTest?.stream)
                await cameraTest.setFilter(filter);
            return;
        }

        if(filter?.protectBackground && !c.userdata.filter) {
            // Detach the unfiltered sender while the protected stream starts.
            try {
                await Promise.all(c.pc.getSenders()
                    .filter(sender => sender.track?.kind === 'video')
                    .map(sender => sender.replaceTrack(null)));
            } catch(e) {
                c.close();
                throw e;
            }
        }
        if(filter)
            c.userdata.filterDefinition = filter;
        else
            delete c.userdata.filterDefinition;
        await replaceUpStream(c);
    }).catch(displayError);
    await cameraFilterUpdate;
}

const filterSelector = getSelectElement('filterselect');
filterSelector.onchange = () => applyCameraFilter(filterSelector.value);

function configureBackgroundImageControl() {
    let option = Array.from(filterSelector.options).find(
        option => option.value === 'background-image',
    );
    if(!option)
        return;

    let input = getInputElement('backgroundimage');
    let play = getButtonElement('playbackgroundvideo');
    let clear = document.getElementById('clearbackgroundimage');
    let status = document.getElementById('backgroundimagestatus');
    let revision = 0;
    option.disabled = true;
    document.getElementById('backgroundimagecontrols').hidden = false;

    input.onchange = async () => {
        let file = input.files?.[0];
        if(!file)
            return;

        let pending = ++revision;
        status.textContent = 'Chargement du fond…';
        try {
            let image = await decodeBackgroundImage(file);
            if(pending !== revision) {
                image.close?.();
                return;
            }
            setBackgroundImage(image);
            option.disabled = false;
            play.hidden = !image.play;
            clear.hidden = false;
            if(filterSelector.value !== option.value) {
                filterSelector.value = option.value;
                await applyCameraFilter(option.value);
            }
            if(pending === revision) {
                let stream = findUpMedia('camera')?.stream || cameraTest?.stream;
                status.textContent = stream?.getVideoTracks().length ?
                    image.play ? 'Fond chargé. Si le fond reste fixe, clique sur Animer le fond.' :
                        'Fond chargé. Le fichier reste dans cet onglet.' :
                    'Fond chargé. Active la caméra ou démarre le test pour le voir.';
            }
        } catch(e) {
            if(pending === revision)
                status.textContent = e instanceof Error ? e.message : 'Impossible de charger le fond.';
        } finally {
            if(pending === revision)
                input.value = '';
        }
    };

    play.onclick = async () => {
        let image = backgroundImage;
        if(!image?.play)
            return;
        try {
            await image.play();
            if(image === backgroundImage)
                status.textContent = 'Animation lancée.';
        } catch(e) {
            if(image === backgroundImage)
                status.textContent = e.name === 'NotAllowedError' ?
                    'Le navigateur bloque la lecture du fond.' :
                    'Le navigateur n’a pas pu lancer la vidéo WebM.';
        }
    };

    clear.onclick = async () => {
        revision++;
        input.value = '';
        setBackgroundImage(null);
        option.disabled = true;
        play.hidden = true;
        clear.hidden = true;
        status.textContent = '';
        if(filterSelector.value === option.value) {
            filterSelector.value = 'background-blur';
            status.textContent = 'Fond personnalisé retiré. Le flou est actif.';
            await applyCameraFilter('background-blur');
        }
    };
}

/**
 * Returns the desired max video throughput depending on the settings.
 *
 * @returns {number}
 */
function getMaxVideoThroughput() {
    let v = getSettings().send;
    switch(v) {
    case 'lowest':
        return 150000;
    case 'low':
        return 300000;
    case 'normal':
        return 700000;
    case 'unlimited':
        return null;
    default:
        console.error('Unknown video quality', v);
        return 700000;
    }
}

getSelectElement('sendselect').onchange = async function(e) {
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({send: this.value});
    await reconsiderSendParameters();
};

getSelectElement('simulcastselect').onchange = async function(e) {
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({simulcast: this.value});
    await reconsiderSendParameters();
};

/**
 * Maps the state of the receive UI element to a protocol request.
 *
 * @param {string} what
 * @returns {Record<string,Array<string>>}
 */

function mapRequest(what) {
    switch(what) {
    case '':
        return {'': []};
    case 'audio':
        return {'': ['audio']};
    case 'screenshare':
        return {screenshare: ['audio','video'], '': ['audio']};
    case 'everything-low':
        return {'': ['audio','video-low']};
    case 'everything':
        return {'': ['audio','video']}
    default:
        throw new Error(`Unknown value ${what} in request`);
    }
}

/**
 * Like mapRequest, but for a single label.
 *
 * @param {string} what
 * @param {string} label
 * @returns {Array<string>}
 */

function mapRequestLabel(what, label) {
    let r = mapRequest(what);
    if(label in r)
        return r[label];
    else
        return r[''];
}


getSelectElement('requestselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({request: this.value});
    requestRoomMedia();
};

const activityDetectionInterval = 200;
const activityDetectionPeriod = 700;
const activityDetectionThreshold = 0.2;

getInputElement('activitybox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({activityDetection: this.checked});
    for(let id in serverConnection.down) {
        let c = serverConnection.down[id];
        if(this.checked)
            c.setStatsInterval(activityDetectionInterval);
        else {
            c.setStatsInterval(0);
            setActive(c, false);
        }
    }
};

getInputElement('displayallbox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({displayAll: this.checked});
    if(!serverConnection)
        return;
    for(let id in serverConnection.down) {
        let c = serverConnection.down[id];
        let elt = document.getElementById('peer-' + c.localId);
        if(elt)
            showHideMedia(c, elt);
    }
    updateCameraOffTiles();
};


/**
 * @this {Stream}
 * @param {Record<string,any>} stats
 */
function gotUpStats(stats) {
    let c = this;

    let values = [];

    for(let id in stats) {
        if(stats[id] && stats[id]['outbound-rtp']) {
            let rate = stats[id]['outbound-rtp'].rate;
            if(typeof rate === 'number') {
                values.push(rate);
            }
        }
    }

    if(values.length === 0) {
        setUpLabel(c, '');
    } else {
        values.sort((x,y) => x - y);
        setUpLabel(c, values
                 .map(x => Math.round(x / 1000).toString())
                 .reduce((x, y) => x + '+' + y));
    }
}

/**
 * @param {Stream} c
 * @param {boolean} value
 */
function setActive(c, value) {
    let peer = document.getElementById('peer-' + c.localId);
    if(value)
        peer.classList.add('peer-active');
    else
        peer.classList.remove('peer-active');

    let user = document.getElementById('user-' + c.source);
    if(user) {
        if(value)
            user.classList.add('user-status-active');
        else
            user.classList.remove('user-status-active');
    }
}

/**
 * @this {Stream}
 * @param {Record<string,any>} stats
 */
function gotDownStats(stats) {
    if(!getInputElement('activitybox').checked)
        return;

    let c = this;

    let maxEnergy = 0;

    c.pc.getReceivers().forEach(r => {
        let tid = r.track && r.track.id;
        let s = tid && stats[tid];
        let energy = s && s['inbound-rtp'] && s['inbound-rtp'].audioEnergy;
        if(typeof energy === 'number')
            maxEnergy = Math.max(maxEnergy, energy);
    });

    // totalAudioEnergy is defined as the integral of the square of the
    // volume, so square the threshold.
    if(maxEnergy > activityDetectionThreshold * activityDetectionThreshold) {
        c.userdata.lastVoiceActivity = Date.now();
        setActive(c, true);
    } else {
        let last = c.userdata.lastVoiceActivity;
        if(!last || Date.now() - last > activityDetectionPeriod)
            setActive(c, false);
    }
}

/**
 * Add an option to an HTMLSelectElement.
 *
 * @param {HTMLSelectElement} select
 * @param {string} label
 * @param {string} [value]
 */
function addSelectOption(select, label, value) {
    if(!value)
        value = label;
    for(let i = 0; i < select.children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value === value) {
            if(child.label !== label) {
                child.label = label;
            }
            return;
        }
    }

    let option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

/**
 * Returns true if an HTMLSelectElement has an option with a given value.
 *
 * @param {HTMLSelectElement} select
 * @param {string} value
 */
function selectOptionAvailable(select, value) {
    let children = select.children;
    for(let i = 0; i < children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value === value)
            return true;
    }
    return false;
}

/**
 * @param {HTMLSelectElement} select
 * @returns {string}
 */
function selectOptionDefault(select) {
    /* First non-empty option. */
    for(let i = 0; i < select.children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value)
            return child.value;
    }
    /* The empty option is always available. */
    return '';
}

/**
  * True if we already went through setMediaChoices twice.
  *
  * @type {boolean}
  */
let mediaChoicesDone = false;

/**
 * Populate the media choices menu.
 *
 * Since media names might not be available before we call
 * getDisplayMedia, we call this function twice, the second time in order
 * to update the menu with user-readable labels.
 *
 * @param{boolean} done
 */
async function setMediaChoices(done) {
    if(mediaChoicesDone)
        return;

    let devices = [];
    try {
        if('mediaDevices' in navigator)
            devices = await navigator.mediaDevices.enumerateDevices();
    } catch(e) {
        console.error(e);
        return;
    }

    let cn = 1, mn = 1;

    devices.forEach(d => {
        let label = d.label;
        if(d.kind === 'videoinput') {
            if(!label)
                label = `Camera ${cn}`;
            addSelectOption(getSelectElement('videoselect'),
                            label, d.deviceId);
            cn++;
        } else if(d.kind === 'audioinput') {
            if(!label)
                label = `Microphone ${mn}`;
            addSelectOption(getSelectElement('audioselect'),
                            label, d.deviceId);
            mn++;
        }
    });

    mediaChoicesDone = done;
}


/**
 * @param {string} [localId]
 */
function newUpStream(localId) {
    if(!serverConnection)
        throw new Error("Not connected");
    let c = serverConnection.newUpStream(localId);
    c.onstatus = function(status) {
        setMediaStatus(c);
        updateCallStatus();
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    return c;
}

/**
 * Sets an up stream's video throughput and simulcast parameters.
 *
 * @param {Stream} c
 * @param {number} bps
 * @param {boolean} simulcast
 */
async function setSendParameters(c, bps, simulcast) {
    if(!c.up)
        throw new Error('Setting throughput of down stream');
    if(c.label === 'screenshare')
        simulcast = false;
    let senders = c.pc.getSenders();
    for(let i = 0; i < senders.length; i++) {
        let s = senders[i];
        if(!s.track || s.track.kind !== 'video')
            continue;
        let p = s.getParameters();
        if((!p.encodings ||
            !simulcast && p.encodings.length !== 1) ||
           (simulcast && p.encodings.length !== 2)) {
            await replaceUpStream(c);
            return;
        }
        p.encodings.forEach(e => {
            if(!e.rid || e.rid === 'h')
                e.maxBitrate = bps || unlimitedRate;
        });
        await s.setParameters(p);
    }
}

let reconsiderParametersTimer = null;

/**
 * Sets the send parameters for all up streams.
 */
async function reconsiderSendParameters() {
    cancelReconsiderParameters();
    let t = getMaxVideoThroughput();
    let s = doSimulcast();
    let promises = [];
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        promises.push(setSendParameters(c, t, s));
    }
    await Promise.all(promises);
}

/**
 * Schedules a call to reconsiderSendParameters after a delay.
 * The delay avoids excessive flapping.
 */
function scheduleReconsiderParameters() {
    cancelReconsiderParameters();
    reconsiderParametersTimer =
        setTimeout(reconsiderSendParameters, 10000 + Math.random() * 10000);
}

function cancelReconsiderParameters() {
    if(reconsiderParametersTimer) {
        clearTimeout(reconsiderParametersTimer);
        reconsiderParametersTimer = null;
    }
}

const unlimitedRate = 1000000000;
const simulcastRate = 100000;
const hqAudioRate = 128000;

/**
 * Decide whether we want to send simulcast.
 *
 * @returns {boolean}
 */
function doSimulcast() {
    switch(getSettings().simulcast) {
    case 'on':
        return true;
    case 'off':
        return false;
    default:
        let count = 0;
        for(let n in serverConnection.users) {
            if(!serverConnection.users[n].permissions["system"]) {
                count++;
                if(count > 2)
                    break;
            }
        }
        if(count <= 2)
            return false;
        let bps = getMaxVideoThroughput();
        return bps <= 0 || bps >= 2 * simulcastRate;
    }
}

/**
 * Sets up c to send the given stream.  Some extra parameters are stored
 * in c.userdata.
 *
 * @param {Stream} c
 * @param {MediaStream} stream
 */

async function setUpStream(c, stream) {
    if(c.stream !== null)
        throw new Error("Setting nonempty stream");

    const protectBackground = c.userdata.filterDefinition?.protectBackground;
    c.setStream(stream);

    // set up the handler early, in case setFilter fails.
    c.onclose = async replace => {
        await removeFilter(c);
        if(!replace) {
            stopStream(c.stream);
            if(c.userdata.onclose)
                c.userdata.onclose.call(c);
            delMedia(c.localId);
        }
    }

    try {
        await setFilter(c);
    } catch(e) {
        if(!protectBackground || !c.sc)
            throw e;
        // A browser unable to capture a filtered canvas can still send audio.
        stream.getVideoTracks().forEach(track => track.stop());
        c.setStream(new MediaStream(stream.getAudioTracks()));
        displayWarning('Effet vidéo indisponible. La caméra est coupée.');
    }
    if(!c.sc)
        throw new Error('Stream closed during setup');

    /**
     * @param {MediaStreamTrack} t
     */
    function addUpTrack(t) {
        let settings = getSettings();
        if(c.label === 'camera') {
            if(t.kind === 'audio') {
                if(settings.localMute)
                    t.enabled = false;
            } else if(t.kind === 'video') {
                if(settings.blackboardMode) {
                    t.contentHint = 'detail';
                }
            }
        }
        t.onended = e => {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        };

        let encodings = [];
        let simulcast = c.label !== 'screenshare' && doSimulcast();
        if(t.kind === 'video') {
            let bps = getMaxVideoThroughput();
            // Firefox doesn't like us setting the RID if we're not
            // simulcasting.
            if(simulcast) {
                encodings.push({
                    rid: 'h',
                    maxBitrate: bps || unlimitedRate,
                });
                encodings.push({
                    rid: 'l',
                    scaleResolutionDownBy: 2,
                    maxBitrate: simulcastRate,
                });
            } else {
                encodings.push({
                    maxBitrate: bps || unlimitedRate,
                });
            }
        } else {
            if(settings.hqaudio) {
                encodings.push({
                    maxBitrate: hqAudioRate,
                });
            }
        }
        let tr = c.pc.addTransceiver(t, {
            direction: 'sendonly',
            streams: [c.stream],
            sendEncodings: encodings,
        });

        // Firefox before 110 does not implement sendEncodings, and
        // requires this hack, which throws an exception on Chromium.
        try {
            let p = tr.sender.getParameters();
            if(!p.encodings) {
                p.encodings = encodings;
                tr.sender.setParameters(p);
            }
        } catch(e) {
        }
    }

    // c.stream might be different from stream if there's a filter
    c.stream.getTracks().forEach(addUpTrack);

    stream.onaddtrack = function(e) {
        if(!protectBackground || e.track.kind !== 'video')
            addUpTrack(e.track);
    };

    stream.onremovetrack = function(e) {
        let t = e.track;

        /** @type {RTCRtpSender} */
        let sender;
        c.pc.getSenders().forEach(s => {
            if(s.track === t)
                sender = s;
        });
        if(sender) {
            c.pc.removeTrack(sender);
        } else {
            console.warn('Removing unknown track');
        }

        let found = false;
        c.pc.getSenders().forEach(s => {
            if(s.track)
                found = true;
        });
        if(!found) {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        }
    };

    c.onstats = gotUpStats;
    c.setStatsInterval(2000);
}

/**
 * Replaces c with a freshly created stream, duplicating any relevant
 * parameters in c.userdata.
 *
 * @param {Stream} c
 * @returns {Promise<Stream>}
 */
async function replaceUpStream(c) {
    await removeFilter(c);
    let cn = newUpStream(c.localId);
    cn.label = c.label;
    if(c.userdata.filterDefinition)
        cn.userdata.filterDefinition = c.userdata.filterDefinition;
    if(c.userdata.onclose)
        cn.userdata.onclose = c.userdata.onclose;
    let media = /** @type{HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    try {
        await setUpStream(cn, c.stream);
    } catch(e) {
        console.error(e);
        displayError(e);
        cn.close();
        c.close();
        return null;
    }

    await setMedia(cn,
                   cn.label === 'camera' && getSettings().mirrorView,
                   cn.label === 'video' && media);

    return cn;
}

/**
 * Replaces all up streams with the given label.  If label is null,
 * replaces all up stream.
 *
 * @param {string} label
 */
async function replaceUpStreams(label) {
    let promises = [];
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(label && c.label !== label)
            continue
        promises.push(replaceUpStream(c));
    }
    await Promise.all(promises);
}

/**
 * Closes and reopens the camera then replaces the camera stream.
 */
function replaceCameraStream() {
    let c = findUpMedia('camera');
    if(c) {
        let media = localMediaState();
        let settings = getSettings();
        addLocalMedia(c.localId, {
            audio: media.audio && !!settings.audio,
            video: media.video && !!settings.video,
        }, true);
    }
}

/**
 * @param {string} [localId]
 * @param {{audio: boolean, video: boolean}} [selection]
 * @param {boolean} [releaseFirst]
 */
async function addLocalMedia(localId, selection, releaseFirst) {
    let connection = serverConnection;
    let settings = getSettings();
    let old = connection.findByLocalId(localId);
    let wantAudio = selection ? selection.audio : !!settings.audio;
    let wantVideo = selection ? selection.video : !!settings.video;

    if(!wantAudio && !wantVideo) {
        if(old)
            old.close();
        setButtonsVisibility();
        return;
    }

    /** @type{false|MediaTrackConstraints} */
    let audio = wantAudio ? (settings.audio ? {deviceId: settings.audio} : {}) : false;
    /** @type{false|MediaTrackConstraints} */
    let video = wantVideo ? (settings.video ? {deviceId: settings.video} : {}) : false;

    if(video) {
        let resolution = settings.resolution;
        if(resolution) {
            video.width = { ideal: resolution[0] };
            video.height = { ideal: resolution[1] };
        } else if(settings.blackboardMode) {
            video.width = { min: 640, ideal: 1920 };
            video.height = { min: 400, ideal: 1080 };
        } else {
            video.aspectRatio = { ideal: 4/3 };
        }
    }

    if(audio) {
        if(!settings.preprocessing) {
            audio.echoCancellation = false;
            audio.noiseSuppression = false;
            audio.autoGainControl = false;
        }
    }

    if(old && releaseFirst) {
        await removeFilter(old);
        stopStream(old.stream);
    }

    let constraints = {audio: audio, video: video};
    /** @type {MediaStream} */
    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch(e) {
        if(old && releaseFirst)
            old.close();
        displayError(e);
        return;
    }

    if(connection !== serverConnection || !connection.group) {
        stopStream(stream);
        return;
    }

    if(old && !releaseFirst) {
        await removeFilter(old);
        if(connection !== serverConnection || !connection.group) {
            stopStream(stream);
            return;
        }
        stopStream(old.stream);
    }
    setMediaChoices(true);
    const audioTrack = stream.getAudioTracks()[0];
    const videoTrack = stream.getVideoTracks()[0];
    if(audioTrack && !settings.audio)
        updateSettings({audio: audioTrack.getSettings().deviceId || 'default'});
    if(videoTrack && !settings.video)
        updateSettings({video: videoTrack.getSettings().deviceId || 'default'});
    let c;

    try {
        c = newUpStream(localId);
    } catch(e) {
        stopStream(stream);
        console.log(e);
        displayError(e);
        return;
    }

    c.label = 'camera';

    if(video && settings.filter !== '')
        c.userdata.filterDefinition = filters[settings.filter] || filters['background-blur'];

    try {
        await setUpStream(c, stream);
        await setMedia(c, settings.mirrorView);
    } catch(e) {
        console.error(e);
        displayError(e);
        c.close();
    }
    setButtonsVisibility();
}

let safariScreenshareDone = false;

async function addShareMedia() {
    let connection = serverConnection;
    if(!safariScreenshareDone) {
        if(isSafari()) {
            let ok = confirm(
                'Screen sharing in Safari is broken.  ' +
                    'It will work at first, ' +
                    'but then your video will randomly freeze.  ' +
                    'Are you sure that you wish to enable screensharing?'
            );
            if(!ok)
                return
        }
        safariScreenshareDone = true;
    }

    /** @type {MediaStream} */
    let stream = null;
    try {
        if(!('getDisplayMedia' in navigator.mediaDevices))
            throw new Error('Your browser does not support screen sharing');
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
        });
    } catch(e) {
        console.error(e);
        displayError(e);
        return;
    }

    if(connection !== serverConnection || !connection.group) {
        stopStream(stream);
        return;
    }
    let c = null;
    try {
        c = newUpStream();
        c.label = 'screenshare';
        await setUpStream(c, stream);
        await setMedia(c);
    } catch(error) {
        if(c)
            c.close();
        else
            stopStream(stream);
        displayError(error);
    }
    setButtonsVisibility();
}

/**
 * @param {File} file
 */
async function addFileMedia(file) {
    let url = URL.createObjectURL(file);
    let video = document.createElement('video');
    video.src = url;
    video.controls = true;
    let stream;
    /** @ts-ignore */
    if(video.captureStream)
        /** @ts-ignore */
        stream = video.captureStream();
    /** @ts-ignore */
    else if(video.mozCaptureStream)
        /** @ts-ignore */
        stream = video.mozCaptureStream();
    else {
        displayError("This browser doesn't support file playback");
        return;
    }

    let c = newUpStream();
    c.label = 'video';
    c.userdata.onclose = function() {
        let media = /** @type{HTMLVideoElement} */
            (document.getElementById('media-' + this.localId));
        if(media && media.src) {
            URL.revokeObjectURL(media.src);
            media.src = null;
        }
    };
    await setUpStream(c, stream);

    let presenting = !!findUpMedia('camera');
    let muted = getSettings().localMute;
    if(presenting && !muted) {
        setLocalMute(true, true);
        displayWarning('You have been muted');
    }

    await setMedia(c, false, video);
    c.userdata.play = true;
    setButtonsVisibility();
}

/**
 * @param {MediaStream} s
 */
function stopStream(s) {
    s.getTracks().forEach(t => {
        try {
            t.stop();
        } catch(e) {
            console.warn(e);
        }
    });
}

/**
 * closeUpMedia closes all up connections with the given label.  If label
 * is null, it closes all up connections.
 *
 * @param {string} [label]
*/
function closeUpMedia(label) {
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(label && c.label !== label)
            continue
        c.close();
    }
}

/**
 * @param {string} label
 * @returns {Stream}
 */
function findUpMedia(label) {
    if(!serverConnection)
        return null;
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(c.label === label)
            return c;
    }
    return null;
}

/**
 * @param {boolean} mute
 */
function muteLocalTracks(mute) {
    if(!serverConnection)
        return;
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(c.label === 'camera') {
            let stream = c.stream;
            stream.getTracks().forEach(t => {
                if(t.kind === 'audio') {
                    t.enabled = !mute;
                }
            });
        }
    }
}

/**
 * @param {string} id
 * @param {boolean} force
 * @param {boolean} [value]
 */
function forceDownRate(id, force, value) {
    let c = serverConnection.down[id];
    if(!c)
        throw new Error("Unknown down stream");
    if('requested' in c.userdata) {
        if(force)
            c.userdata.requested.force = !!value;
        else
            delete(c.userdata.requested.force);
    } else {
        if(force)
            c.userdata.requested = {force: value};
    }
    reconsiderDownRate(id);
}

/**
 * Maps 'video' to 'video-low'.  Returns null if nothing changed.
 *
 * @param {string[]} requested
 * @returns {string[]}
 */
function mapVideoToLow(requested) {
    let result = [];
    let found = false;
    for(let i = 0; i < requested.length; i++) {
        let r = requested[i];
        if(r === 'video') {
            r = 'video-low';
            found = true;
        }
        result.push(r);
    }
    if(!found)
        return null;
    return result;
}

/**
 * Reconsider the video track requested for a given down stream.
 *
 * @param {string} [id] - the id of the track to reconsider, all if null.
 */
function reconsiderDownRate(id) {
    if(!serverConnection)
        return;
    if(!id) {
        for(let id in serverConnection.down) {
            reconsiderDownRate(id);
        }
        return;
    }
    let c = serverConnection.down[id];
    if(!c)
        throw new Error("Unknown down stream");
    let normalrequest = mapRequestLabel(effectiveReceiveMode(), c.label);

    let requestlow = mapVideoToLow(normalrequest);
    if(requestlow === null)
        return;

    let old = c.userdata.requested;
    let low = false;
    if(old && ('force' in old)) {
        low = old.force;
    } else {
        let media = /** @type {HTMLVideoElement} */
            (document.getElementById('media-' + c.localId));
        if(!media)
            return;
        let w = media.scrollWidth;
        let h = media.scrollHeight;
        if(w && h && w * h <= 320 * 240) {
            low = true;
        }
    }

    if(low !== !!(old && old.low)) {
        if('requested' in c.userdata)
            c.userdata.requested.low = low;
        else
            c.userdata.requested = {low: low};
        c.request(low ? requestlow : null);
    }
}

let reconsiderDownRateTimer = null;

/**
 * Schedules reconsiderDownRate() to be run later.  The delay avoids too
 * much recomputations when resizing the window.
 */
function scheduleReconsiderDownRate() {
    if(reconsiderDownRateTimer)
        return;
    reconsiderDownRateTimer =
        setTimeout(() => {
            reconsiderDownRateTimer = null;
            reconsiderDownRate();
        }, 200);
}

/**
 * setMedia adds a new media element corresponding to stream c.
 *
 * @param {Stream} c
 * @param {boolean} [mirror]
 *     - whether to mirror the video
 * @param {HTMLVideoElement} [video]
 *     - the video element to add.  If null, a new element with custom
 *       controls will be created.
 */
async function setMedia(c, mirror, video) {
    let div = document.getElementById('peer-' + c.localId);
    if(!div) {
        div = document.createElement('div');
        div.id = 'peer-' + c.localId;
        div.classList.add('peer');
        let peersdiv = document.getElementById('participant-tiles');
        peersdiv.appendChild(div);
    }

    if(c.label === 'screenshare')
        div.dataset.shareOwner = c.up ? serverConnection.id : c.source;
    else
        delete div.dataset.shareOwner;

    showHideMedia(c, div)

    let media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if(!media) {
        if(video) {
            media = video;
        } else {
            media = document.createElement('video');
            if(c.up)
                media.muted = true;
        }

        media.classList.add('media');
        media.autoplay = true;
        media.playsInline = true;
        media.id = 'media-' + c.localId;
        div.appendChild(media);
        addCustomControls(media, div, c, !!video);
    }

    if(mirror)
        media.classList.add('mirror');
    else
        media.classList.remove('mirror');

    if(!video && media.srcObject !== c.stream)
        media.srcObject = c.stream;

    if(!c.up) {
        media.onfullscreenchange = function(e) {
            forceDownRate(c.id, document.fullscreenElement === media, false);
        }
    }

    let label = document.getElementById('label-' + c.localId);
    if(!label) {
        label = document.createElement('div');
        label.id = 'label-' + c.localId;
        label.classList.add('label');
        label.classList.add(c.up ? 'up-stream' : 'down-stream');
        label.dataset.defaultText = '';
        label.dataset.fallbackText = '';
        label.dataset.showFallback = 'false';
        label.onclick = function() {
            let showFallback = (label.dataset.showFallback === 'true');
            label.dataset.showFallback = showFallback ? 'false' : 'true';
            updateLabelElement(label);
        };
        div.appendChild(label);
    }

    setUpLabel(c, '');
    setMediaStatus(c);

    showVideo();
    resizePeers();
}


/**
 * @param {Stream} c
 * @param {HTMLElement} elt
 */
function showHideMedia(c, elt) {
    let hasVideo = !!c.stream?.getVideoTracks().some(track => track.readyState === 'live');
    elt.classList.toggle('ux-audio-only', !hasVideo);
    elt.classList.toggle('peer-hidden', !(c.up || hasVideo || getSettings().displayAll));
}

function updateCameraOffTiles() {
    const peers = document.getElementById('participant-tiles');
    const users = document.body.dataset.callState === 'connected' && getSettings().displayAll ?
        Object.entries(serverConnection.users).filter(([id, user]) =>
            id !== serverConnection.id && !user.permissions.includes('system') &&
            !Object.values(user.streams).some(stream => stream.audio || stream.video)) : [];
    const pending = new Map(users.map(([id, user]) => [id, user.username || 'Anonyme']));
    for(const peer of peers.querySelectorAll('[data-camera-off]')) {
        const id = peer.getAttribute('data-camera-off');
        if(!pending.has(id)) {
            peer.remove();
        } else {
            peer.querySelector('.label').textContent = pending.get(id);
            pending.delete(id);
        }
    }
    for(const [id, name] of pending) {
        const peer = document.createElement('div');
        peer.className = 'peer ux-audio-only';
        peer.dataset.cameraOff = id;
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = name;
        peer.appendChild(label);
        peers.appendChild(peer);
    }
    showVideo();
    resizePeers();
}

/**
 * resetMedia resets the source stream of the media element associated
 * with c.  This has the side-effect of resetting any frozen frames.
 *
 * @param {Stream} c
 */
function resetMedia(c) {
    let media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if(!media) {
        console.error("Resetting unknown media element")
        return;
    }
    media.srcObject = media.srcObject;
}

/**
 * @param {Element} elt
 */
function cloneHTMLElement(elt) {
    if(!(elt instanceof HTMLElement))
        throw new Error('Unexpected element type');
    return /** @type{HTMLElement} */(elt.cloneNode(true));
}

/**
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 * @param {Stream} c
 * @param {boolean} toponly
 */
function addCustomControls(media, container, c, toponly) {
    if(!toponly && !document.getElementById('controls-' + c.localId)) {
        media.controls = false;

        let template =
            document.getElementById('videocontrols-template').firstElementChild;
        let controls = cloneHTMLElement(template);
        controls.id = 'controls-' + c.localId;

        let volume = getVideoButton(controls, 'volume');

        if(c.up && c.label === 'camera') {
            volume.remove();
        } else {
            setVolumeButton(media.muted,
                            getVideoButton(controls, "volume-mute"),
                            getVideoButton(controls, "volume-slider"));
        }
        container.appendChild(controls);
    }

    if(c.up && !document.getElementById('topcontrols-' + c.localId)) {
        let toptemplate =
            document.getElementById('topvideocontrols-template').firstElementChild;
        let topcontrols = cloneHTMLElement(toptemplate);
        topcontrols.id = 'topcontrols-' + c.localId;
        container.appendChild(topcontrols);
    }
    registerControlHandlers(c.localId, media, container);
}

/**
 * @param {HTMLElement} container
 * @param {string} name
 */
function getVideoButton(container, name) {
    return /** @type {HTMLElement} */(container.getElementsByClassName(name)[0]);
}

/**
 * @param {boolean} muted
 * @param {HTMLElement} button
 * @param {HTMLElement} slider
 */
function setVolumeButton(muted, button, slider) {
    if(!muted) {
        button.classList.remove("fa-volume-mute");
        button.classList.add("fa-volume-up");
    } else {
        button.classList.remove("fa-volume-up");
        button.classList.add("fa-volume-mute");
    }

    if(!(slider instanceof HTMLInputElement))
        throw new Error("Couldn't find volume slider");
    slider.disabled = muted;
}

/**
 * @param {string} localId
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 */
function registerControlHandlers(localId, media, container) {
    let play = getVideoButton(container, 'video-play');
    if(play) {
        play.onclick = function(event) {
            event.preventDefault();
            media.play();
        };
    }

    let stop = getVideoButton(container, 'video-stop');
    if(stop) {
        stop.onclick = function(event) {
            event.preventDefault();
            try {
                let c = serverConnection.findByLocalId(localId);
                if(!c)
                    throw new Error('Closing unknown stream');
                c.close();
            } catch(e) {
                console.error(e);
                displayError(e);
            }
        };
    }

    let volume = getVideoButton(container, 'volume');
    if (volume) {
        volume.onclick = function(event) {
            let target = /** @type{HTMLElement} */(event.target);
            if(!target.classList.contains('volume-mute'))
                // if click on volume slider, do nothing
                return;
            event.preventDefault();
            media.muted = !media.muted;
            setVolumeButton(media.muted, target,
                            getVideoButton(volume, "volume-slider"));
        };
        volume.oninput = function() {
          let slider = /** @type{HTMLInputElement} */
              (getVideoButton(volume, "volume-slider"));
          media.volume = parseFloat(slider.value)/100;
        };
    }

    let pip = getVideoButton(container, 'pip');
    if(pip) {
        if(HTMLVideoElement.prototype.requestPictureInPicture) {
            pip.onclick = function(e) {
                e.preventDefault();
                if(media.requestPictureInPicture) {
                    media.requestPictureInPicture();
                } else {
                    displayWarning('Picture in Picture not supported.');
                }
            };
        } else {
            pip.style.display = 'none';
        }
    }

    let fs = getVideoButton(container, 'fullscreen');
    if(fs) {
        if(HTMLVideoElement.prototype.requestFullscreen ||
           /** @ts-ignore */
           HTMLVideoElement.prototype.webkitRequestFullscreen) {
            fs.onclick = function(e) {
                e.preventDefault();
                if(media.requestFullscreen) {
                    media.requestFullscreen();
                /** @ts-ignore */
                } else if(media.webkitRequestFullscreen) {
                    /** @ts-ignore */
                    media.webkitRequestFullscreen();
                } else {
                    displayWarning('Full screen not supported!');
                }
            };
        } else {
            fs.style.display = 'none';
        }
    }
}

/**
 * @param {string} localId
 */
function delMedia(localId) {
    let peer = document.getElementById('peer-' + localId);
    if(!peer) {
        setButtonsVisibility();
        return;
    }

    let media = /** @type{HTMLVideoElement} */
        (document.getElementById('media-' + localId));

    if(media)
        media.srcObject = null;
    peer.remove();

    setButtonsVisibility();
    resizePeers();
    hideVideo();
}

/**
 * @param {Stream} c
 */
function setMediaStatus(c) {
    let state = c && c.pc && c.pc.iceConnectionState;
    let good = state === 'connected' || state === 'completed';

    let media = document.getElementById('media-' + c.localId);
    if(!media) {
        console.warn('Setting status of unknown media.');
        return;
    }
    if(good) {
        media.classList.remove('media-failed');
        if(c.userdata.play) {
            if(media instanceof HTMLMediaElement)
                media.play().catch(e => {
                    console.error(e);
                    displayError(e);
                });
            delete(c.userdata.play);
        }
    } else {
        media.classList.add('media-failed');
    }

    if(!c.up && state === 'failed') {
        let from = c.username ?
            `from user ${c.username}` :
            'from anonymous user';
        displayWarning(`Cannot receive media ${from}, still trying...`);
    }
}


/**
 * @param {Stream} c
 * @param {string} [fallback]
 */
function setUpLabel(c, fallback) {
    let label = document.getElementById('label-' + c.localId);
    if(!label)
        return;
    label.dataset.defaultText = c.username;
    label.dataset.fallbackText = fallback;
    updateLabelElement(label);
}

/**
 * @param {HTMLElement} label
 */
function updateLabelElement(label) {
    let defaultText = label.dataset.defaultText;
    let fallbackText = label.dataset.fallbackText;
    let showFallback = (label.dataset.showFallback === 'true');
    if(showFallback) {
        label.textContent = fallbackText || '(unknown)';
        label.classList.add('label-fallback');
    } else {
        label.textContent = defaultText;
        label.classList.remove('label-fallback');
    }
}

function resizePeers() {
    // Window resize can call this method too early
    if (!serverConnection)
        return;
    let peers = document.getElementById('peers');
    if(updatePresentationLayout()) {
        peers.style.removeProperty('grid-template-columns');
        for(const media of peers.querySelectorAll('.media')) {
            if(media instanceof HTMLMediaElement)
                media.style.removeProperty('max-height');
        }
        return;
    }
    let count = peers.querySelectorAll('.peer:not(.peer-hidden)').length;
    let columns = Math.ceil(Math.sqrt(count));
    if (!count)
        // No video, nothing to resize.
        return;
    let container = document.getElementById("video-container");
    let rows = Math.ceil(count / columns);

    if (count <= 2 && container.offsetHeight > container.offsetWidth) {
        peers.style['grid-template-columns'] = "repeat(1, 1fr)";
        rows = count;
    } else {
        peers.style['grid-template-columns'] = `repeat(${columns}, 1fr)`;
    }
    if (count === 1)
        return;
    let margins = (rows - 1) * 5 + 40;
    let max_video_height = (peers.offsetHeight - margins) / rows;
    let media_list = peers.querySelectorAll(".media");
    for(let i = 0; i < media_list.length; i++) {
        let media = media_list[i];
        if(!(media instanceof HTMLMediaElement)) {
            console.warn('Unexpected media');
            continue;
        }
        media.style['max-height'] = max_video_height + "px";
    }
}

/**
 * Lexicographic order, with case differences secondary.
 * @param{string} a
 * @param{string} b
 */
function stringCompare(a, b) {
    let la = a.toLowerCase();
    let lb = b.toLowerCase();
    if(la < lb)
        return -1;
    else if(la > lb)
        return +1;
    else if(a < b)
        return -1;
    else if(a > b)
        return +1;
    return 0
}

/**
 * @param {string} v
 */
function dateFromInput(v) {
    let d = new Date(v);
    if(d.toString() === 'Invalid Date')
        throw new Error('Invalid date');
    return d;
}

/**
 * @param {Date} d
 */
function dateToInput(d) {
    let dd = new Date(d);
    dd.setMinutes(dd.getMinutes() - dd.getTimezoneOffset());
    return dd.toISOString().slice(0, -1);
}

let invitationPending = false;

/** @param {boolean} pending */
function setInvitationPending(pending) {
    invitationPending = pending;
    getButtonElement('invite-submit').disabled = pending;
}

function inviteMenu() {
    let dialog = /** @type {HTMLDialogElement} */(document.getElementById('invite-dialog'));
    if(dialog.open)
        return;
    let start = getInputElement('invite-not-before');
    let expires = getInputElement('invite-expires');
    let now = new Date();
    now.setSeconds(0, 0);
    start.min = expires.min = dateToInput(now);
    if(!invitationPending) {
        start.value = '';
        getInputElement('invite-username').value = '';
        getSelectElement('invite-duration').value = '24';
        expires.value = dateToInput(new Date(now.getTime() + units.d));
        document.getElementById('invite-custom').hidden = true;
        document.getElementById('invite-result').hidden = true;
        document.getElementById('invite-status').textContent = '';
    }
    dialog.showModal();
}

getButtonElement('invite-button').onclick = inviteMenu;
getButtonElement('invite-cancel').onclick = () => {
    /** @type {HTMLDialogElement} */(document.getElementById('invite-dialog')).close();
};

getSelectElement('invite-duration').onchange = function() {
    let custom = getSelectElement('invite-duration').value === 'custom';
    document.getElementById('invite-custom').hidden = !custom;
    if(custom)
        document.getElementById('invite-options').setAttribute('open', '');
};

document.getElementById('invite-form').onsubmit = function(e) {
    e.preventDefault();
    if(invitationPending)
        return;
    let status = document.getElementById('invite-status');
    if(makeTokenPredicate()) {
        status.textContent = 'Tu ne peux pas créer d’invitation dans ce salon.';
        return;
    }
    let duration = getSelectElement('invite-duration').value;
    let start = getInputElement('invite-not-before').value;
    let expires = getInputElement('invite-expires').value;
    let username = getInputElement('invite-username').value.trim();
    let template = {};
    try {
        if(username)
            template.username = username;
        if(start)
            template['not-before'] = dateFromInput(start);
        if(duration === 'custom') {
            if(!expires)
                throw new Error('Choisis une date d’expiration.');
            template.expires = dateFromInput(expires);
            if(template.expires <= (template['not-before'] || new Date()))
                throw new Error('Choisis une expiration après le début du lien.');
        } else if(start) {
            template.expires = new Date(template['not-before'].getTime() + Number(duration) * units.h);
        } else {
            template.expires = Number(duration) * units.h;
        }
        document.getElementById('invite-result').hidden = true;
        status.textContent = 'Création du lien…';
        setInvitationPending(true);
        makeToken(template);
    } catch(error) {
        status.textContent = error.message;
        setInvitationPending(false);
    }
};

getButtonElement('invite-copy').onclick = async function() {
    let field = getInputElement('invite-link');
    let status = document.getElementById('invite-status');
    try {
        await navigator.clipboard.writeText(field.value);
        status.textContent = 'Lien d’invitation copié.';
    } catch(error) {
        field.focus();
        field.select();
        status.textContent = 'Lien sélectionné. Utilise la commande Copier de ton appareil.';
    }
};

/** @param {unknown} value */
function speakingTicket(value) {
    if(value === true)
        return 0; // Clients loaded before the speaking queue send a boolean.
    if(typeof value === 'number' && value > 0 && Number.isSafeInteger(value))
        return value;
    return null;
}

function speakingQueue() {
    return Object.entries(serverConnection.users)
        .map(([id, user]) => ({id, user, ticket: speakingTicket(user.data.raisehand)}))
        .filter(entry => entry.ticket !== null)
        .sort((a, b) => a.ticket - b.ticket || (a.id < b.id ? -1 : 1));
}

/** @param {boolean} raised @param {string} [question] */
function setHandRaised(raised, question) {
    const queue = speakingQueue();
    const own = queue.find(entry => entry.id === serverConnection.id);
    if(raised === !!own && !question)
        return;
    // Put a new request after the last visible one. Simultaneous requests
    // can get the same ticket and are ordered consistently by participant ID.
    const last = queue[queue.length - 1];
    const ticket = last ? Math.min(last.ticket + 1, Number.MAX_SAFE_INTEGER) : 1;
    serverConnection.userAction('setdata', serverConnection.id, {
        raisehand: raised ? own?.ticket ?? ticket : null,
        speakingQuestion: raised && question ? question : null,
    });
}

/** @param {ReturnType<typeof speakingQueue>} queue */
function renderSpeakingQueue(queue) {
    const ownId = serverConnection?.id;
    const position = queue.findIndex(entry => entry.id === ownId) + 1;
    const list = document.getElementById('speaking-order');
    list.replaceChildren(...queue.map(({id, user}) => {
        const item = document.createElement('li');
        item.textContent = user.username || 'Anonyme';
        if(id === ownId) {
            item.classList.add('ux-own-turn');
            item.append(' (toi)');
        }
        if(typeof user.data.speakingQuestion === 'string' && user.data.speakingQuestion.length <= 400) {
            const question = document.createElement('small');
            question.className = 'ux-speaking-question';
            question.textContent = user.data.speakingQuestion;
            item.appendChild(question);
        }
        return item;
    }));
    document.getElementById('speaking-queue').hidden = queue.length === 0;
    const label = position === 1 ? 'Terminer mon tour' :
        position > 1 ? 'Quitter la file' : 'Lever la main';
    const status = position === 1 ? 'À toi de parler' :
        position > 1 ? `${position} / ${queue.length} dans la file` : '';
    const labelElement = document.getElementById('hand-label');
    const statusElement = document.getElementById('hand-position');
    if(labelElement.textContent !== label)
        labelElement.textContent = label;
    if(statusElement.textContent !== status)
        statusElement.textContent = status;
}

/** @param {HTMLElement} elt */
function userMenu(elt) {
    if(!elt.id.startsWith('user-'))
        throw new Error('Unexpected id for user menu');
    let id = elt.id.slice('user-'.length);
    let user = serverConnection.users[id];
    if(!user)
        throw new Error("Couldn't find user")
    let items = [];
    if(id === serverConnection.id) {
        const raised = speakingTicket(user.data.raisehand) !== null;
        items.push({label: raised ? 'Baisser la main' : 'Lever la main',
                    onClick: () => setHandRaised(!raised)});
        if(serverConnection.version !== "1" &&
           serverConnection.permissions.indexOf('token') >= 0) {
            items.push({label: 'Inviter une personne', onClick: () => {
                inviteMenu();
            }});
        }
        if(serverConnection.permissions.indexOf('present') >= 0 && canFile())
            items.push({label: 'Diffuser un fichier', onClick: presentFile});
        items.push({label: 'Relancer le son et la vidéo', onClick: renegotiateStreams});
    } else {
        items.push({label: 'Envoyer un fichier', onClick: () => {
            sendFile(id);
        }});
        if(serverConnection.permissions.indexOf('op') >= 0) {
            items.push({type: 'seperator'}); // sic
            if(user.permissions.indexOf('present') >= 0)
                items.push({label: 'Retirer le droit de présenter', onClick: () => {
                    serverConnection.userAction('unpresent', id);
                }});
            else
                items.push({label: 'Autoriser à présenter', onClick: () => {
                    serverConnection.userAction('present', id);
                }});
            items.push({label: 'Couper le micro', onClick: () => {
                serverConnection.userMessage('mute', id);
            }});
            items.push({label: 'Exclure du salon', onClick: () => {
                serverConnection.userAction('kick', id);
            }});
            items.push({label: 'Identifier', onClick: () => {
                serverConnection.userAction('identify', id);
            }});
        }
    }
    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string} id
 * @param {user} userinfo
 */
function addUser(id, userinfo) {
    let div = document.getElementById('users');
    let user = document.createElement('div');
    user.id = 'user-' + id;
    user.classList.add("user-p");
    user.tabIndex = 0;
    user.setAttribute('role', 'button');
    user.setAttribute('aria-haspopup', 'menu');
    user.addEventListener('keydown', event => {
        if(event.key !== 'Enter' && event.key !== ' ')
            return;
        event.preventDefault();
        userMenu(user);
    });
    setUserStatus(id, user, userinfo);
    user.addEventListener('click', function(e) {
        let elt = e.currentTarget;
        if(!elt || !(elt instanceof HTMLElement))
            throw new Error("Couldn't find user div");
        userMenu(elt);
    });

    let us = div.children;

    if(id === serverConnection.id) {
        if(us.length === 0)
            div.appendChild(user);
        else
            div.insertBefore(user, us[0]);
        return;
    }

    if(userinfo.username) {
        for(let i = 0; i < us.length; i++) {
            let child = us[i];
            let childid = child.id.slice('user-'.length);
            if(childid === serverConnection.id)
                continue;
            let childuser = serverConnection.users[childid] || null;
            let childname = (childuser && childuser.username) || null;
            if(!childname || stringCompare(childname, userinfo.username) > 0) {
                div.insertBefore(user, child);
                return;
            }
        }
    }

    div.appendChild(user);
}

 /**
  * @param {string} id
  * @param {user} userinfo
  */
function changeUser(id, userinfo) {
    let elt = document.getElementById('user-' + id);
    if(!elt) {
        console.warn('Unknown user ' + id);
        return;
    }
    setUserStatus(id, elt, userinfo);
}

/**
 * @param {string} id
 * @param {HTMLElement} elt
 * @param {user} userinfo
 */
function setUserStatus(id, elt, userinfo) {
    elt.textContent = userinfo.username ? userinfo.username : '(anon)';
    if(speakingTicket(userinfo.data.raisehand) !== null)
        elt.classList.add('user-status-raisehand');
    else
        elt.classList.remove('user-status-raisehand');

    let microphone=false, camera = false;
    for(let label in userinfo.streams) {
        for(let kind in userinfo.streams[label]) {
            if(kind === 'audio')
                microphone = true;
            else
                camera = true;
        }
    }
    if(camera) {
        elt.classList.remove('user-status-microphone');
        elt.classList.add('user-status-camera');
    } else if(microphone) {
        elt.classList.add('user-status-microphone');
        elt.classList.remove('user-status-camera');
    } else {
        elt.classList.remove('user-status-microphone');
        elt.classList.remove('user-status-camera');
    }
}

/**
 * @param {string} id
 */
function delUser(id) {
    let div = document.getElementById('users');
    let user = document.getElementById('user-' + id);
    div.removeChild(user);
}

/**
 * @param {string} id
 * @param {string} kind
 */
const notifiedHands = new Set();
let notificationAudio = null;
let notificationsReadyAt = 0;

function playMeetingNotice(hand) {
    try {
        notificationAudio = notificationAudio || new AudioContext();
        if(notificationAudio.state !== 'running')
            return;
        const oscillator = notificationAudio.createOscillator();
        const gain = notificationAudio.createGain();
        const now = notificationAudio.currentTime;
        oscillator.frequency.value = hand ? 660 : 480;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.045, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
        oscillator.connect(gain).connect(notificationAudio.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.23);
    } catch(e) {
        console.warn('Notification audio unavailable', e);
    }
}
document.addEventListener('click', () => {
    try {
        notificationAudio = notificationAudio || new AudioContext();
        if(notificationAudio.state === 'suspended')
            notificationAudio.resume().catch(() => {});
    } catch(e) { /* Audio is optional. */ }
}, {passive: true});

function gotUser(id, kind) {
    const other = id !== serverConnection.id && !serverConnection.users[id]?.permissions?.includes('system');
    if(kind === 'add' && other) {
        if(Date.now() > notificationsReadyAt && notificationsReadyAt)
            playMeetingNotice(false);
    }
    if(id === serverConnection.id && kind === 'add')
        notificationsReadyAt = Date.now() + 3000;
    if(kind === 'change' && other) {
        const raised = speakingTicket(serverConnection.users[id]?.data?.raisehand) !== null;
        if(raised && !notifiedHands.has(id))
            playMeetingNotice(true);
        if(raised) notifiedHands.add(id); else notifiedHands.delete(id);
    }
    if(kind === 'delete') notifiedHands.delete(id);
    switch(kind) {
    case 'add':
        addUser(id, serverConnection.users[id]);
        if(Object.keys(serverConnection.users).length === 3)
            reconsiderSendParameters();
        break;
    case 'delete':
        delUser(id);
        reactionSenders.delete(id);
        if(Object.keys(serverConnection.users).length < 3)
            scheduleReconsiderParameters();
        break;
    case 'change':
        changeUser(id, serverConnection.users[id]);
        break;
    default:
        console.warn('Unknown user kind', kind);
        break;
    }
    let count = Object.keys(serverConnection.users).filter(id => serverConnection.users[id].permissions.indexOf('system') < 0).length;
    let badge = document.getElementById('participant-count');
    badge.textContent = count ? String(count) : '';
    renderSpeakingQueue(speakingQueue());
    updateCameraOffTiles();
    reflectCaptioning();
    renderBreakouts();
}

function displayUsername() {
    document.getElementById('userspan').textContent = serverConnection.username;
    let op = serverConnection.permissions.indexOf('op') >= 0;
    let present = serverConnection.permissions.indexOf('present') >= 0;
    let text = '';
    if(op && present)
        text = '(op, presenter)';
    else if(op)
        text = 'operator';
    else if(present)
        text = 'presenter';
    document.getElementById('permspan').textContent = text;
}

/** @type {{audio: boolean, video: boolean}|null} */
/** @type {{audio:boolean, video:boolean, muted?:boolean}|null} */
let presentRequested = null;

/**
 * @param {string} s
 */
function capitalise(s) {
    if(s.length <= 0)
        return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} title
 */
function setTitle(title) {
    function set(title) {
        document.title = title;
        document.getElementById('title').textContent = title;
    }
    if(title)
        set(title);
    else
        set('Galène');
}

/**
 * Under Safari, we request access to the camera at startup in order to
 * enable autoplay.  The camera stream is stored in safariStream.
 *
 * @type {MediaStream}
 */
let safariStream = null;

async function openSafariStream() {
    if(!isSafari())
        return;

    if(!safariStream)
        safariStream = await navigator.mediaDevices.getUserMedia({audio: true})
}

async function closeSafariStream() {
    if(!safariStream)
        return;
    stopStream(safariStream);
    safariStream = null;
}

/**
 * @this {ServerConnection}
 * @param {string} kind
 * @param {string} group
 * @param {Array<string>} perms
 * @param {Record<string,any>} status
 * @param {Record<string,any>} data
 * @param {string} error
 * @param {string} message
 */
async function gotJoined(kind, group, perms, status, data, error, message) {
    let present = presentRequested;
    presentRequested = null;

    if(this !== serverConnection)
        return;
    switch(kind) {
    case 'waiting':
        presentRequested = present;
        setWaitingRoom(true);
        return;
    case 'fail':
        if(probingState === 'probing' && error === 'need-username') {
            probingState = 'need-username';
            setVisibility('passwordform', false);
        } else {
            token = null;
            setJoinError(error === 'admission-denied' ? 'Le modérateur a refusé ton entrée.' :
                error === 'not-authorised' || /not authorised/i.test(message || '') ?
                'Accès refusé. Vérifie le nom et le mot de passe du salon.' :
                'Impossible de rejoindre le salon. ' + (message || 'Réessaie.'));
            getInputElement('password').focus();
        }
        closeSafariStream();
        this.close();
        setButtonsVisibility();
        return;
    case 'redirect':
        closeSafariStream();
        this.close();
        token = null;
        document.location.href = message;
        return;
    case 'leave':
        closeSafariStream();
        this.close();
        setButtonsVisibility();
        setChangePassword(null);
        return;
    case 'join':
    case 'move':
    case 'change':
        if(probingState === 'probing') {
            probingState = 'success';
            setVisibility('userform', false);
            setVisibility('passwordform', false);
            closeSafariStream();
            this.close();
            setButtonsVisibility();
            return;
        } else {
            token = null;
        }
        if(kind === 'move') {
            resetRoomTools();
            resetMeetingTools();
            resetReactions();
            resetBreakouts();
            selectCallPanel(null);
        }
        if(kind === 'join' || kind === 'move') {
            setConnected(true);
            showVideo();
            document.getElementById('mainrow').focus();
        }
        // don't discard endPoint and friends
        for(let key in status)
            groupStatus[key] = status[key];
        setTitle((status && status.displayName) || capitalise(group));
        reflectSharedBoard(data?.sharedBoard, data?.presentBoard === true);
        reflectLobbyEnabled(data?.requireAdmission);
        reflectCaptioning(data?.captioningEnabled === true);
        displayUsername();
        setButtonsVisibility();
        setChangePassword(pwAuth && !!groupStatus.canChangePassword &&
                          serverConnection.username
        );
        openSafariStream();
        if(kind === 'change')
            return;
        break;
    default:
        token = null;
        displayError('Unknown join message');
        closeSafariStream();
        this.close();
        return;
    }

    let input = /** @type{HTMLTextAreaElement} */
        (document.getElementById('input'));
    input.placeholder = 'Écrire un message';

    if(status.locked)
        displayWarning('This group is locked');

    if(typeof RTCPeerConnection === 'undefined')
        displayWarning("This browser doesn't support WebRTC");
    else
        this.request(mapRequest(effectiveReceiveMode()));

    if(('mediaDevices' in navigator) &&
       ('getUserMedia' in navigator.mediaDevices) &&
       serverConnection.permissions.indexOf('present') >= 0 &&
       !findUpMedia('camera')) {
        if(present && (present.audio || present.video)) {
            if(cameraTest) {
                await cameraTest.stopStream();
                await cameraTest.setAnalyser();
            }
            if(present.audio)
                updateSettings({localMute: present.muted ?? false});
            await switchLocalMedia(present.audio, present.video);
        }
    }
}

/**
 * @param {TransferredFile} f
 */
function gotFileTransfer(f) {
    f.onevent = gotFileTransferEvent;
    let p = document.createElement('p');
    if(f.up)
        p.textContent =
        `We have offered to send a file called "${f.name}" ` +
        `to user ${f.username}.`;
    else
        p.textContent =
        `User ${f.username} offered to send us a file ` +
        `called "${f.name}" of size ${f.size}.`
    let bno = null, byes = null;
    if(!f.up) {
        byes = document.createElement('button');
        byes.textContent = 'Accept';
        byes.onclick = function(e) {
            f.receive();
        };
        byes.id = "byes-" + f.fullid();
    }
    bno = document.createElement('button');
    bno.textContent = f.up ? 'Cancel' : 'Reject';
    bno.onclick = function(e) {
        f.cancel();
    };
    bno.id = "bno-" + f.fullid();
    let status = document.createElement('span');
    status.id = 'status-' + f.fullid();
    if(!f.up) {
        status.textContent =
            '(Choosing "Accept" will disclose your IP address.)';
    }
    let statusp = document.createElement('p');
    statusp.id = 'statusp-' + f.fullid();
    statusp.appendChild(status);
    let div = document.createElement('div');
    div.id = 'file-' + f.fullid();
    div.appendChild(p);
    if(byes)
        div.appendChild(byes);
    if(bno)
        div.appendChild(bno);
    div.appendChild(statusp);
    div.classList.add('message');
    div.classList.add('message-private');
    div.classList.add('message-row');
    let box = document.getElementById('box');
    box.appendChild(div);
    return div;
}

/**
 * @param {TransferredFile} f
 * @param {string} status
 * @param {number} [value]
 */
function setFileStatus(f, status, value) {
    let statuselt = document.getElementById('status-' + f.fullid());
    if(!statuselt)
        throw new Error("Couldn't find statusp");
    statuselt.textContent = status;
    if(value) {
        let progress = document.getElementById('progress-' + f.fullid());
         if(!progress || !(progress instanceof HTMLProgressElement))
            throw new Error("Couldn't find progress element");
        progress.value = value;
        let label = document.getElementById('progresstext-' + f.fullid());
        let percent = Math.round(100 * value / progress.max);
        label.textContent = `${percent}%`;
    }
}

/**
 * @param {TransferredFile} f
 * @param {number} [max]
 */
function createFileProgress(f, max) {
    let statusp = document.getElementById('statusp-' + f.fullid());
    if(!statusp)
        throw new Error("Couldn't find status div");
    /** @type HTMLProgressElement */
    let progress = document.createElement('progress');
    progress.id = 'progress-' + f.fullid();
    progress.classList.add('file-progress');
    progress.max = max;
    progress.value = 0;
    statusp.appendChild(progress);
    let progresstext = document.createElement('span');
    progresstext.id = 'progresstext-' + f.fullid();
    progresstext.textContent = '0%';
    statusp.appendChild(progresstext);
}

/**
 * @param {TransferredFile} f
 * @param {boolean} delyes
 * @param {boolean} delno
 * @param {boolean} [delprogress]
 */
function delFileStatusButtons(f, delyes, delno, delprogress) {
    let div = document.getElementById('file-' + f.fullid());
    if(!div)
        throw new Error("Couldn't find file div");
    if(delyes) {
        let byes = document.getElementById('byes-' + f.fullid())
        if(byes)
            div.removeChild(byes);
    }
    if(delno) {
        let bno = document.getElementById('bno-' + f.fullid())
        if(bno)
            div.removeChild(bno);
    }
    if(delprogress) {
        let statusp = document.getElementById('statusp-' + f.fullid());
        let progress = document.getElementById('progress-' + f.fullid());
        let progresstext =
            document.getElementById('progresstext-' + f.fullid());
        if(progress)
            statusp.removeChild(progress);
        if(progresstext)
            statusp.removeChild(progresstext);
    }
}

/**
 * @this {TransferredFile}
 * @param {string} state
 * @param {any} [data]
 */
function gotFileTransferEvent(state, data) {
    let f = this;
    switch(state) {
    case 'inviting':
        break;
    case 'connecting':
        delFileStatusButtons(f, true, false);
        setFileStatus(f, 'Connecting...');
        createFileProgress(f, f.size);
        break;
    case 'connected':
        setFileStatus(f, f.up ? 'Sending...' : 'Receiving...', f.datalen);
        break;
    case 'done':
        delFileStatusButtons(f, true, true, true);
        setFileStatus(f, 'Done.');
        if(!f.up) {
            let url = URL.createObjectURL(data);
            let a = document.createElement('a');
            a.href = url;
            a.textContent = f.name;
            a.download = f.name;
            a.type = f.mimetype;
            a.click();
            URL.revokeObjectURL(url);
        }
        break;
    case 'cancelled':
        delFileStatusButtons(f, true, true, true);
        if(data)
            setFileStatus(f, `Cancelled: ${data.toString()}.`);
        else
            setFileStatus(f, 'Cancelled.');
        break;
    case 'closed':
        break;
    default:
        console.error(`Unexpected state "${state}"`);
        f.cancel(`unexpected state "${state}" (this shouldn't happen)`);
        break;
    }
}

function groupsBase() {
    let url = window.location.href;
    if(!url.endsWith(group + '/'))
       return '';
    return url.slice(0, -(group.length + 1));
}

const reactionLayer = document.getElementById('reaction-layer');
const reactionPicker = document.getElementById('reaction-picker');
const reactionsToggle = getButtonElement('reactions-toggle');
const reactionChoices = [...reactionPicker.querySelectorAll('button[data-reaction]')];
const permittedReactions = new Set(reactionChoices.map(button => button.getAttribute('data-reaction')));
/** @type {Map<string, number>} */
const reactionSenders = new Map();
/** @type {Map<string, number[]>} */
const reactionWaves = new Map();
let lastReactionSent = -Infinity;
let lastReactionBurst = -Infinity;

/** @param {boolean} open */
function setReactionPicker(open) {
    reactionPicker.hidden = !open;
    reactionsToggle.setAttribute('aria-expanded', String(open));
}

function resetReactions() {
    setReactionPicker(false);
    reactionLayer.replaceChildren();
    reactionSenders.clear();
    reactionWaves.clear();
    lastReactionSent = -Infinity;
    lastReactionBurst = -Infinity;
}

/** @param {string} emoji */
function showReactionBurst(emoji) {
    const burst = document.createElement('div');
    burst.className = 'ux-reaction-burst';
    burst.style.setProperty('--x', `${30 + Math.random() * 40}%`);
    const star = document.createElement('span');
    star.className = 'ux-reaction-star';
    star.textContent = emoji;
    burst.appendChild(star);
    const colors = ['#ffcd60', '#ff829c', '#a4f3cd', '#94c4ff'];
    for(let i = 0; i < 20; i++) {
        const spark = document.createElement('i');
        spark.className = 'ux-reaction-spark';
        spark.style.setProperty('--angle', `${i * 18 + Math.random() * 14}deg`);
        spark.style.setProperty('--distance', `${3 + Math.random() * 6}rem`);
        spark.style.setProperty('--color', colors[i % colors.length]);
        burst.appendChild(spark);
    }
    reactionLayer.appendChild(burst);
    setTimeout(() => burst.remove(), 1500);
}

/** @param {string} id @param {unknown} emoji */
function receiveReaction(id, emoji) {
    if(document.body.dataset.callState !== 'connected' || !serverConnection.users[id] ||
       typeof emoji !== 'string' || !permittedReactions.has(emoji))
        return;
    const now = performance.now();
    if(now - (reactionSenders.get(id) ?? -Infinity) < 100)
        return;
    reactionSenders.set(id, now);

    const float = document.createElement('span');
    const duration = 4200 + Math.random() * 1000;
    float.className = 'ux-reaction';
    float.textContent = emoji;
    float.style.setProperty('--x', `${10 + Math.random() * 80}%`);
    float.style.setProperty('--drift', `${Math.random() * 66 - 33}px`);
    float.style.setProperty('--tilt', `${Math.random() * 26 - 13}deg`);
    float.style.setProperty('--size', `${1.7 + Math.random() * .8}rem`);
    float.style.setProperty('--duration', `${duration}ms`);
    if(reactionLayer.childElementCount >= 56)
        reactionLayer.querySelector('.ux-reaction')?.remove();
    reactionLayer.appendChild(float);
    const displayTime = window.matchMedia('(prefers-reduced-motion: reduce)').matches ?
        2400 : duration;
    setTimeout(() => float.remove(), displayTime);

    const wave = (reactionWaves.get(emoji) || []).filter(time => now - time < 2500);
    wave.push(now);
    if(wave.length >= 8 && now - lastReactionBurst > 3000) {
        lastReactionBurst = now;
        reactionWaves.delete(emoji);
        showReactionBurst(emoji);
    } else {
        reactionWaves.set(emoji, wave);
    }
}

reactionsToggle.onclick = () => {
    const open = reactionPicker.hidden;
    setRoomToolsOpen(false);
    setReactionPicker(open);
    if(open)
        /** @type {HTMLButtonElement} */ (reactionChoices[0]).focus();
};
for(const choice of reactionChoices) {
    choice.addEventListener('click', () => {
        const now = performance.now();
        if(now - lastReactionSent < 165 || !serverConnection?.group ||
           !serverConnection.permissions.includes('message'))
            return;
        lastReactionSent = now;
        serverConnection.userMessage('room-reaction', '', choice.getAttribute('data-reaction'));
    });
}
document.addEventListener('click', event => {
    const target = /** @type {Node} */ (event.target);
    if(!reactionPicker.hidden && !reactionPicker.contains(target) && !reactionsToggle.contains(target))
        setReactionPicker(false);
});

/**
 * @param {string} id
 * @param {string} dest
 * @param {string} username
 * @param {Date} time
 * @param {boolean} privileged
 * @param {string} kind
 * @param {string} error
 * @param {any} message
 */
function gotUserMessage(id, dest, username, time, privileged, kind, error, message) {
    switch(kind) {
    case 'breakout-state':
        if(!id && privileged)
            receiveBreakouts(message);
        break;
    case 'breakout-error':
        if(!id && privileged) {
            const warning = 'Impossible de modifier les sous-salles. Vérifie que la session est ouverte et que le participant est toujours là.';
            breakoutMessage(warning);
            if(!breakoutDialog.open)
                displayWarning(warning);
        }
        break;
    case 'board-state':
        if(!id && privileged)
            receiveBoardState(message);
        break;
    case 'board-change':
        if(!id && privileged)
            receiveBoardChange(message);
        break;
    case 'board-error':
        if(!id && privileged)
            document.getElementById('board-feedback').textContent = message === 'board is full' ?
                'Le tableau est plein. Exporte le dessin avant de l’effacer.' : 'Cette action est indisponible.';
        break;
    case 'meeting-state':
        if(!id && privileged)
            reflectMeetingState(message);
        break;
    case 'meeting-error':
        if(!id && privileged)
            showMeetingError(message);
        break;
    case 'lobby-state':
        if(!id && privileged && serverConnection.permissions.includes('op'))
            reflectWaitingGuests(message);
        break;
    case 'room-reaction':
        if(!dest && !error)
            receiveReaction(id, message);
        break;
    case 'share-pointer':
        if(!dest && !error)
            receiveSharePointer(id, message);
        break;
    case 'share-annotation':
        if(!dest && !error)
            receiveShareAnnotation(id, message);
        break;
    case 'kicked':
    case 'error':
    case 'warning':
    case 'info': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let from = id ? (username || 'Anonymous') : 'The Server';
        displayError(`${from} said: ${message}`, kind);
        break;
    }
    case 'mute': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        setLocalMute(true, true);
        let by = username ? ' by ' + username : '';
        displayWarning(`You have been muted${by}`);
        break;
    }
    case 'clearchat': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let id = message && message.id;
        let userId = message && message.userId;
        clearChat(id, userId);
        break;
    }
    case 'token': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let invitation = invitationPending;
        if(invitation)
            setInvitationPending(false);
        if(error || typeof message !== 'object' || !message) {
            if(invitation)
                document.getElementById('invite-status').textContent = 'La création du lien a échoué.';
            else
                displayError(error ? 'Token operation failed: ' + message : 'Unexpected type for token');
            return;
        }
        let f = formatToken(message, false);
        if(invitation) {
            getInputElement('invite-link').value = f[1];
            document.getElementById('invite-result').hidden = false;
            document.getElementById('invite-status').textContent = 'Lien prêt à partager.';
            if(/** @type {HTMLDialogElement} */(document.getElementById('invite-dialog')).open)
                getButtonElement('invite-copy').focus();
            else
                localMessage(f[0] + ': ' + f[1]);
            break;
        }
        localMessage(f[0] + ': ' + f[1]);
        if('share' in navigator) {
            try {
                navigator.share({
                    title: `Invitation to Galene group ${message.group}`,
                    text: f[0],
                    url: f[1],
                });
            } catch(e) {
                console.warn("Share failed", e);
            }
        }
        break;
    }
    case 'tokenlist': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        if(error) {
            displayError(`Token operation failed: ${message}`)
            return
        }
        let s = '';
        for(let i = 0; i < message.length; i++) {
            let f = formatToken(message[i], true);
            s = s + f[0] + ': ' + f[1] + "\n";
        }
        localMessage(s);
        break;
    }
    case 'userinfo': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let u = message.username ?
            'username ' + message.username :
            'unknown username';
        let a = message.address ?
            'address ' + message.address :
            'unknown address';
        localMessage(`User ${message.id} has ${u} and ${a}.`);
        break;
    }
    case 'subgrouplist': {
        if(id) {
            console.error(`Got message kind ${kind} not from server`);
            return;
        }
        let div = document.createElement('div');
        if(message.length == 0) {
            div.textContent = 'No subgroups.';
        } else {
            let base = groupsBase();
            for(let i = 0; i < message.length; i++) {
                if(i != 0)
                    div.appendChild(document.createElement('br'));
                let sg = message[i];
                let g;
                if(base) {
                    g = document.createElement('a');
                    g.textContent = sg.name;
                    g.href = base + sg.name + '/';
                    g.target = '_blank';
                } else {
                    g = document.createTextNode(sg.name);
                }
                div.appendChild(g);
                let count =
                    !(sg.clientCount) ? ': empty' :
                    sg.clientCount == 1 ? ': 1 client' :
                    `: ${sg.clientCount} clients`
                div.appendChild(document.createTextNode(count));
            }
        }
        localMessage(div);
        break;
    }
    default:
        console.warn(`Got unknown user message ${kind}`);
        break;
    }
};

/**
 * @param {Object} token
 * @param {boolean} [details]
 */
function formatToken(token, details) {
    let url = new URL(window.location.href);
    let params = new URLSearchParams();
    params.append('token', token.token);
    url.search = params.toString();
    let foruser = '', by = '', togroup = '';
    if(token.username)
        foruser = ` for user ${token.username}`;
    if(details) {
        if(token.issuedBy)
            by = ' issued by ' + token.issuedBy;
        if(token.issuedAt) {
            if(by === '')
                by = ' issued at ' + (new Date(token.issuedAt)).toLocaleString();
            else
                by = by + ' at ' + (new Date(token.issuedAt)).toLocaleString();
        }
    } else {
        if(token.group)
            togroup = ' to group ' + token.group;
    }
    let since = '';
    if(token["not-before"])
        since = ` since ${(new Date(token['not-before'])).toLocaleString()}`
    /** @type{Date} */
    let expires = null;
    let until = '';
    if(token.expires) {
        expires = new Date(token.expires)
        until = ` until ${expires.toLocaleString()}`;
    }
    return [
        (expires && (expires >= new Date())) ?
            `Invitation${foruser}${togroup}${by} valid${since}${until}` :
            `Expired invitation${foruser}${togroup}${by}`,
        url.toString(),
    ];
}

const urlRegexp = /https?:\/\/[-a-zA-Z0-9@:%/._\\+~#&()=?]+[-a-zA-Z0-9@:%/_\\+~#&()=]/g;

/**
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function formatText(text) {
    let r = new RegExp(urlRegexp);
    let result = [];
    let pos = 0;
    while(true) {
        let m = r.exec(text);
        if(!m)
            break;
        result.push(document.createTextNode(text.slice(pos, m.index)));
        let a = document.createElement('a');
        a.href = m[0];
        a.textContent = m[0];
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        result.push(a);
        pos = m.index + m[0].length;
    }
    result.push(document.createTextNode(text.slice(pos)));

    let div = document.createElement('div');
    result.forEach(e => {
        div.appendChild(e);
    });
    return div;
}

/**
 * @param {Date} time
 * @returns {string}
 */
function formatTime(time) {
    let delta = Date.now() - time.getTime();
    let m = time.getMinutes();
    if(delta > -30000)
        return time.getHours() + ':' + ((m < 10) ? '0' : '') + m;
    return time.toLocaleString();
}

/**
 * @typedef {Object} lastMessage
 * @property {string} [nick]
 * @property {string} [peerId]
 * @property {string} [dest]
 * @property {Date} [time]
 */

/** @type {lastMessage} */
let lastMessage = {};

/**
 * @param {string} id
 * @param {string} peerId
 * @param {string} dest
 * @param {string} nick
 * @param {Date} time
 * @param {boolean} privileged
 * @param {boolean} history
 * @param {string} kind
 * @param {string|HTMLElement} message
 */
function addToChatbox(id, peerId, dest, nick, time, privileged, history, kind, message) {
    if(kind === 'caption') {
        if(showCaptions && !history)
            displayCaption(message);
        return;
    }

    let row = document.createElement('div');
    row.classList.add('message-row');
    let container = document.createElement('div');
    container.classList.add('message');
    row.appendChild(container);
    let footer = document.createElement('p');
    footer.classList.add('message-footer');
    if(!peerId)
        container.classList.add('message-system');
    if(serverConnection && peerId === serverConnection.id)
        container.classList.add('message-sender');
    if(dest)
        container.classList.add('message-private');

    if(id)
        container.dataset.id = id;
    if(peerId) {
        container.dataset.peerId = peerId;
        container.dataset.username = nick;
        container.addEventListener('click', function(e) {
            if(e.detail !== 2)
                return;
            let elt = e.currentTarget;
            if(!elt || !(elt instanceof HTMLElement))
                throw new Error("Couldn't find chat message div");
            chatMessageMenu(elt);
        });
    }

    /** @type{HTMLElement} */
    let body;
    if(message instanceof HTMLElement) {
        body = message;
    } else if(typeof message === 'string') {
        body = formatText(message);
    } else {
        throw new Error('Cannot add element to chatbox');
    }

    if(kind !== 'me') {
        let doHeader = true;
        if(lastMessage.nick !== (nick || null) ||
           lastMessage.peerId !== (peerId || null) ||
           lastMessage.dest !== (dest || null) ||
           !time || !lastMessage.time) {
            doHeader = true;
        } else {
            let delta = time.getTime() - lastMessage.time.getTime();
            doHeader = delta < 0 || delta > 60000;
        }

        if(doHeader) {
            let header = document.createElement('p');
            let u = dest && serverConnection.users[dest];
            let name = (u && u.username);
            // messages with null id are sent by the server
            if(id || nick) {
                let user = document.createElement('span');
                if(dest)
                    user.textContent =
                        `${nick || '(anon)'} \u2192 ${name || '(anon)'}`;
                else
                    user.textContent = (nick || '(anon)');
                user.classList.add('message-user');
                header.appendChild(user);
            }
            header.classList.add('message-header');
            container.appendChild(header);
            if(time) {
                let tm = document.createElement('span');
                tm.textContent = formatTime(time);
                tm.classList.add('message-time');
                header.appendChild(tm);
            }
        }

        let p = document.createElement('p');
        p.appendChild(body);
        p.classList.add('message-content');
        container.appendChild(p);
        lastMessage.nick = (nick || null);
        lastMessage.peerId = peerId;
        lastMessage.dest = (dest || null);
        lastMessage.time = (time || null);
    } else {
        let asterisk = document.createElement('span');
        asterisk.textContent = '*';
        asterisk.classList.add('message-me-asterisk');
        let user = document.createElement('span');
        user.textContent = nick || '(anon)';
        user.classList.add('message-me-user');
        body.classList.add('message-me-content');
        container.appendChild(asterisk);
        container.appendChild(user);
        container.appendChild(body);
        container.classList.add('message-me');
        lastMessage = {};
    }
    container.appendChild(footer);

    let box = document.getElementById('box');
    box.appendChild(row);
    if(box.scrollHeight > box.clientHeight) {
        box.scrollTop = box.scrollHeight - box.clientHeight;
    }

    return;
}

/**
 * @param {HTMLElement} elt
 */
function chatMessageMenu(elt) {
    if(!(serverConnection && serverConnection.permissions &&
         serverConnection.permissions.indexOf('op') >= 0))
        return;

    let messageId = elt.dataset.id;
    let peerId = elt.dataset.peerId;
    if(!peerId)
        return;
    let username = elt.dataset.username;
    let u = username || 'user';

    let items = [];
    if(messageId)
        items.push({label: 'Delete message', onClick: () => {
            serverConnection.groupAction('clearchat', {
                id: messageId,
                userId: peerId,
            });
        }});
    items.push({label: `Delete all from ${u}`,
                onClick: () => {
                    serverConnection.groupAction('clearchat', {
                        userId: peerId,
                    });
                }});
    items.push({label: `Identify ${u}`, onClick: () => {
        serverConnection.userAction('identify', peerId);
    }});
    items.push({label: `Kick out ${u}`, onClick: () => {
        serverConnection.userAction('kick', peerId);
    }});

    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string|HTMLElement} message
 */
function setCaption(message) {
    let container = document.getElementById('captions-container');
    let captions = document.getElementById('captions');
    if(!message) {
        captions.replaceChildren();
        container.classList.add('invisible');
    } else {
        if(message instanceof HTMLElement)
            captions.replaceChildren(message);
        else
            captions.textContent = message;
        container.classList.remove('invisible');
    }
}

let captionsTimer = null;

/**
 * @param {string|HTMLElement} message
 */
function displayCaption(message) {
    if(captionsTimer !== null) {
        clearTimeout(captionsTimer);
        captionsTimer = null;
    }
    setCaption(message);
    captionsTimer = setTimeout(() => setCaption(null), 3000);
}

/**
 * @param {string|HTMLElement} message
 */
function localMessage(message) {
    return addToChatbox(null, null, null, null, new Date(), false, false, '', message);
}

/**
 * @param {string} [id]
 * @param {string} [userId]
 */
function clearChat(id, userId) {
    lastMessage = {};

    let box = document.getElementById('box');
    if(!id && !userId) {
        box.textContent = '';
        return;
    }

    let elts = box.children;
    let i = 0;
    while(i < elts.length) {
        let row = elts.item(i);
        if(row instanceof HTMLDivElement) {
            let div = row.firstChild;
            if(div instanceof HTMLDivElement)
                if((!id || div.dataset.id === id) &&
                   div.dataset.peerId === userId) {
                    box.removeChild(row);
                    continue;
                }
        }
        i++;
    }
}

/**
 * A command known to the command-line parser.
 *
 * @typedef {Object} command
 * @property {string} [parameters]
 *     - A user-readable list of parameters.
 * @property {string} [description]
 *     - A user-readable description, null if undocumented.
 * @property {() => string} [predicate]
 *     - Returns null if the command is available.
 * @property {(c: string, r: string) => void} f
 */

/**
 * The set of commands known to the command-line parser.
 *
 * @type {Object.<string,command>}
 */
let commands = {};

function operatorPredicate() {
    if(serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('op') >= 0)
        return null;
    return 'You are not an operator';
}

function recordingPredicate() {
    if(serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('record') >= 0)
        return null;
    return 'You are not allowed to record';
}

commands.help = {
    description: 'display this help',
    f: (c, r) => {
        /** @type {string[]} */
        let cs = [];
        for(let cmd in commands) {
            let c = commands[cmd];
            if(!c.description)
                continue;
            if(c.predicate && c.predicate())
                continue;
            cs.push(`/${cmd}${c.parameters?' ' + c.parameters:''}: ${c.description}`);
        }
        localMessage(cs.sort().join('\n'));
    }
};

commands.me = {
    f: (c, r) => {
        // handled as a special case
        throw new Error("this shouldn't happen");
    }
};

commands.set = {
    f: (c, r) => {
        if(!r) {
            let settings = getSettings();
            let s = "";
            for(let key in settings)
                s = s + `${key}: ${JSON.stringify(settings[key])}\n`;
            localMessage(s);
            return;
        }
        let p = parseCommand(r);
        let value;
        if(p[1]) {
            value = JSON.parse(p[1]);
        } else {
            value = true;
        }
        updateSetting(p[0], value);
        reflectSettings();
    }
};

commands.unset = {
    f: (c, r) => {
        delSetting(r.trim());
        return;
    }
};

commands.leave = {
    description: "leave group",
    f: (c, r) => {
        if(!serverConnection)
            throw new Error('Not connected');
        serverConnection.close();
    }
};

commands.clear = {
    predicate: operatorPredicate,
    description: 'clear the chat history',
    f: (c, r) => {
        serverConnection.groupAction('clearchat');
    }
};

commands.lock = {
    predicate: operatorPredicate,
    description: 'lock this group',
    parameters: '[message]',
    f: (c, r) => {
        serverConnection.groupAction('lock', r);
    }
};

commands.unlock = {
    predicate: operatorPredicate,
    description: 'unlock this group, revert the effect of /lock',
    f: (c, r) => {
        serverConnection.groupAction('unlock');
    }
};

commands.record = {
    predicate: recordingPredicate,
    description: 'start recording',
    f: (c, r) => {
        serverConnection.groupAction('record');
    }
};

commands.unrecord = {
    predicate: recordingPredicate,
    description: 'stop recording',
    f: (c, r) => {
        serverConnection.groupAction('unrecord');
    }
};

commands.subgroups = {
    predicate: operatorPredicate,
    description: 'list subgroups',
    f: (c, r) => {
        serverConnection.groupAction('subgroups');
    }
};

commands.touchsubgroup = {
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0])
            throw new Error(`/${c} requires parameters`);
        let url = document.location.href + p[0];
        fetch(url, {"method": "HEAD"})
            .then(r => {
                if(r.status >= 300) {
                    displayError(`Group ${p[0]}: ${r.status} ${r.statusText}`);
                }
            })
            .catch(e => displayError(e));
    }
}

commands.msgsubgroup = {
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0] || !p[1])
            throw new Error(`/${c} requires parameters`);
        let id = findUserId(p[0]);
        if(!id)
            throw new Error(`Unknown user ${p[0]}`);
        let url = document.location.href + p[1];
        let m = `Please join the group at <${encodeURI(url)}/>.`;
        serverConnection.chat('', id, m);
        addToChatbox(serverConnection.id, null, id, serverConnection.username,
                     new Date(), false, false, '', m);
    }
}

/**
 * @type {Record<string,number>}
 */
const units = {
    s: 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    mon: 31 * 24 * 60 * 60 * 1000,
    yr: 365 * 24 * 60 * 60 * 1000,
};

/**
 * @param {string} s
 * @returns {Date|number}
 */
function parseExpiration(s) {
    if(!s)
        return null;
    let re = /^([0-9]+)(s|min|h|d|mon|yr)$/
    let e = re.exec(s)
    if(e) {
        let unit = units[e[2]];
        if(!unit)
            throw new Error(`Couldn't find unit ${e[2]}`);
        return parseInt(e[1]) * unit;
    }
    let d = new Date(s);
    if(d.toString() === 'Invalid Date')
        throw new Error("Couldn't parse expiration date");
    return d;
}

function makeTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ?
            "You don't have permission to create tokens" : null);
}

function editTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ||
            serverConnection.permissions.indexOf('op') < 0 ?
            "You don't have permission to edit or list tokens" : null);
}

/**
 * @param {Object} [template]
 */
function makeToken(template) {
    if(!template)
        template = {};
    let v = {
        group: group,
    }
    if('username' in template)
        v.username = template.username;
    if('expires' in template)
        v.expires = template.expires;
    else
        v.expires = units.d;
    if('not-before' in template)
        v["not-before"] = template["not-before"];
    if('permissions' in template)
        v.permissions = template.permissions;
    else {
        v.permissions = [];
        if(serverConnection.permissions.indexOf('present') >= 0)
            v.permissions.push('present');
        if(serverConnection.permissions.indexOf('message') >= 0)
            v.permissions.push('message');
    }
    serverConnection.groupAction('maketoken', v);
}

commands.invite = {
    predicate: makeTokenPredicate,
    description: "create an invitation link",
    parameters: "[username] [expiration]",
    f: (c, r) => {
        let p = parseCommand(r);
        let template = {};
        if(p[0])
            template.username = p[0];
        let expires = parseExpiration(p[1]);
        if(expires)
            template.expires = expires;
        makeToken(template);
    }
}

/**
 * @param {string} t
 */
function parseToken(t) {
    let m = /^https?:\/\/.*?token=([^?]+)/.exec(t);
    if(m) {
        return m[1];
    } else if(!/^https?:\/\//.exec(t)) {
        return t
    } else {
        throw new Error("Couldn't parse link");
    }
}

commands.reinvite = {
    predicate: editTokenPredicate,
    description: "extend an invitation link",
    parameters: "link [expiration]",
    f: (c, r) => {
        let p = parseCommand(r);
        let v = {}
        v.token = parseToken(p[0]);
        if(p[1])
            v.expires = parseExpiration(p[1]);
        else
            v.expires = units.d;
        serverConnection.groupAction('edittoken', v);
    }
}

commands.revoke = {
    predicate: editTokenPredicate,
    description: "revoke an invitation link",
    parameters: "link",
    f: (c, r) => {
        let token = parseToken(r);
        serverConnection.groupAction('edittoken', {
            token: token,
            expires: -units.s,
        });
    }
}

commands.listtokens = {
    predicate: editTokenPredicate,
    description: "list invitation links",
    f: (c, r) => {
        serverConnection.groupAction('listtokens');
    }
}

function renegotiateStreams() {
    for(let id in serverConnection.up)
        serverConnection.up[id].restartIce();
    for(let id in serverConnection.down)
        serverConnection.down[id].restartIce();
}

commands.renegotiate = {
    description: 'renegotiate media streams',
    f: (c, r) => {
        renegotiateStreams();
    }
};

commands.replace = {
    f: (c, r) => {
        replaceUpStreams(null);
    }
};

commands.sharescreen = {
    description: 'start a screen share',
    f: (c, r) => {
        addShareMedia();
    }
}

commands.unsharescreen = {
    description: 'stop screen share',
    f: (c, r) => {
        closeUpMedia('screenshare');
    }
}

/**
 * parseCommand splits a string into two space-separated parts.  The first
 * part may be quoted and may include backslash escapes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCommand(line) {
    let i = 0;
    while(i < line.length && line[i] === ' ')
        i++;
    let start = ' ';
    if(i < line.length && (line[i] === '"' || line[i] === "'")) {
        start = line[i];
        i++;
    }
    let first = "";
    while(i < line.length) {
        if(line[i] === start) {
            if(start !== ' ')
                i++;
            break;
        }
        if(line[i] === '\\' && i < line.length - 1)
            i++;
        first = first + line[i];
        i++;
    }

    while(i < line.length && line[i] === ' ')
        i++;
    return [first, line.slice(i)];
}

/**
 * @param {string} user
 */
function findUserId(user) {
    if(user in serverConnection.users)
        return user;

    for(let id in serverConnection.users) {
        let u = serverConnection.users[id];
        if(u && u.username === user)
            return id;
    }
    return null;
}

commands.msg = {
    parameters: 'user message',
    description: 'send a private message',
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0])
            throw new Error('/msg requires parameters');
        let id = findUserId(p[0]);
        if(!id)
            throw new Error(`Unknown user ${p[0]}`);
        serverConnection.chat('', id, p[1]);
        addToChatbox(serverConnection.id, null, id, serverConnection.username,
                     new Date(), false, false, '', p[1]);
    }
};

/**
   @param {string} c
   @param {string} r
*/
function userCommand(c, r) {
    let p = parseCommand(r);
    if(!p[0])
        throw new Error(`/${c} requires parameters`);
    let id = findUserId(p[0]);
    if(!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userAction(c, id, p[1]);
}

function userMessage(c, r) {
    let p = parseCommand(r);
    if(!p[0])
        throw new Error(`/${c} requires parameters`);
    let id = findUserId(p[0]);
    if(!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userMessage(c, id, p[1]);
}

commands.kick = {
    parameters: 'user [message]',
    description: 'kick out a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.identify = {
    parameters: 'user [message]',
    description: 'identify a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.op = {
    parameters: 'user',
    description: 'give operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unop = {
    parameters: 'user',
    description: 'revoke operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.present = {
    parameters: 'user',
    description: 'give user the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unpresent = {
    parameters: 'user',
    description: 'revoke the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.shutup = {
    parameters: 'user',
    description: 'revoke the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unshutup = {
    parameters: 'user',
    description: 'give the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.mute = {
    parameters: 'user',
    description: 'mute a remote user',
    predicate: operatorPredicate,
    f: userMessage,
};

commands.muteall = {
    description: 'mute all remote users',
    predicate: operatorPredicate,
    f: (c, r) => {
        serverConnection.userMessage('mute', null, null, true);
    }
}

commands.warn = {
    parameters: 'user message',
    description: 'send a warning to a user',
    predicate: operatorPredicate,
    f: (c, r) => {
        userMessage('warning', r);
    },
};

commands.wall = {
    parameters: 'message',
    description: 'send a warning to all users',
    predicate: operatorPredicate,
    f: (c, r) => {
        if(!r)
            throw new Error('empty message');
        serverConnection.userMessage('warning', '', r);
    },
};

commands.raise = {
    description: 'raise hand',
    f: () => setHandRaised(true),
}

commands.unraise = {
    description: 'unraise hand',
    f: () => setHandRaised(false),
}

/** @returns {boolean} */
function canFile() {
    let v =
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.captureStream ||
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.mozCaptureStream;
    return v;
}

function presentFile() {
    let input = document.createElement('input');
    input.type = 'file';
    input.accept="audio/*,video/*";
    input.onchange = function(e) {
        if(!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        let files = this.files;
        for(let i = 0; i < files.length; i++) {
            addFileMedia(files[i]).catch(e => {
                console.error(e);
                displayError(e);
            });
        }
    };
    input.click();
}

commands.presentfile = {
    description: 'broadcast a video or audio file',
    f: (c, r) => {
        presentFile();
    },
    predicate: () => {
        if(!canFile())
            return 'Your browser does not support presenting arbitrary files';
        if(!serverConnection || !serverConnection.permissions ||
           serverConnection.permissions.indexOf('present') < 0)
            return 'You are not authorised to present.';
        return null;
    }
};


/**
 * @param {string} id
 */
function sendFile(id) {
    let input = document.createElement('input');
    input.type = 'file';
    input.onchange = function(e) {
        if(!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        let files = this.files;
        for(let i = 0; i < files.length; i++) {
            try {
                serverConnection.sendFile(id, files[i]);
            } catch(e) {
                console.error(e);
                displayError(e);
            }
        }
    };
    input.click();
}

commands.sendfile = {
    parameters: 'user',
    description: 'send a file (this will disclose your IP address)',
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0])
            throw new Error(`/${c} requires parameters`);
        let id = findUserId(p[0]);
        if(!id)
            throw new Error(`Unknown user ${p[0]}`);
        sendFile(id);
    },
};

/**
 * Test loopback through a TURN relay.
 *
 * @returns {Promise<number>}
 */
async function relayTest() {
    if(!serverConnection)
        throw new Error('not connected');
    let conf = Object.assign({}, serverConnection.getRTCConfiguration());
    conf.iceTransportPolicy = 'relay';
    let pc1 = new RTCPeerConnection(conf);
    let pc2 = new RTCPeerConnection(conf);
    pc1.onicecandidate = e => {e.candidate && pc2.addIceCandidate(e.candidate);};
    pc2.onicecandidate = e => {e.candidate && pc1.addIceCandidate(e.candidate);};
    try {
        return await new Promise(async (resolve, reject) => {
            let d1 = pc1.createDataChannel('loopbackTest');
            d1.onopen = e => {
                d1.send(Date.now().toString());
            };

            let offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(pc1.localDescription);
            let answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(pc2.localDescription);

            pc2.ondatachannel = e => {
                let d2 = e.channel;
                d2.onmessage = e => {
                    let t = parseInt(e.data);
                    if(isNaN(t))
                        reject(new Error('corrupt data'));
                    else
                        resolve(Date.now() - t);
                }
            }

            setTimeout(() => reject(new Error('timeout')), 5000);
        })
    } finally {
        pc1.close();
        pc2.close();
    }
}

commands['relay-test'] = {
    f: async (c, r) => {
        localMessage('Relay test in progress...');
        try {
            let s = Date.now();
            let rtt = await relayTest();
            let e = Date.now();
            localMessage(`Relay test successful in ${e-s}ms, RTT ${rtt}ms`);
        } catch(e) {
            localMessage(`Relay test failed: ${e}`);
        }
    }
}

function handleInput() {
    let input = /** @type {HTMLTextAreaElement} */
        (document.getElementById('input'));
    let data = input.value;
    input.value = '';

    let message, me;

    if(data === '')
        return;

    if(data[0] === '/') {
        if(data.length > 1 && data[1] === '/') {
            message = data.slice(1);
            me = false;
        } else {
            let cmd, rest;
            let space = data.indexOf(' ');
            if(space < 0) {
                cmd = data.slice(1);
                rest = '';
            } else {
                cmd = data.slice(1, space);
                rest = data.slice(space + 1);
            }

            if(cmd === 'me') {
                message = rest;
                me = true;
            } else {
                let c = commands[cmd];
                if(!c) {
                    displayError(
                        `Unknown command /${cmd}, type /help for help`
                    );
                    return;
                }
                if(c.predicate) {
                    let s = c.predicate();
                    if(s) {
                        displayError(s);
                        return;
                    }
                }
                try {
                    c.f(cmd, rest);
                } catch(e) {
                    console.error(e);
                    displayError(e);
                }
                return;
            }
        }
    } else {
        message = data;
        me = false;
    }

    if(!serverConnection || !serverConnection.socket) {
        displayError("Not connected.");
        return;
    }

    try {
        serverConnection.chat(me ? 'me' : '', '', message);
    } catch(e) {
        console.error(e);
        displayError(e);
    }
}

document.getElementById('inputform').onsubmit = function(e) {
    e.preventDefault();
    handleInput();
};

document.getElementById('input').onkeypress = function(e) {
    if(e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        handleInput();
    }
};

function chatResizer(e) {
    e.preventDefault();
    let full_width = document.getElementById("mainrow").offsetWidth;
    let left = document.getElementById("left");
    let right = document.getElementById("right");

    let start_x = e.clientX;
    let start_width = left.offsetWidth;

    function start_drag(e) {
        let left_width = (start_width + e.clientX - start_x) * 100 / full_width;
        // set min chat width to 300px
        let min_left_width = 300 * 100 / full_width;
        if (left_width < min_left_width) {
          return;
        }
        left.style.flex = left_width.toString();
        right.style.flex = (100 - left_width).toString();
    }
    function stop_drag(e) {
        document.documentElement.removeEventListener(
            'mousemove', start_drag, false,
        );
        document.documentElement.removeEventListener(
            'mouseup', stop_drag, false,
        );
    }

    document.documentElement.addEventListener(
        'mousemove', start_drag, false,
    );
    document.documentElement.addEventListener(
        'mouseup', stop_drag, false,
    );
}

document.getElementById('resizer').addEventListener('mousedown', chatResizer, false);

/**
 * @param {unknown} message
 * @param {string} [level]
 */
function displayError(message, level) {
    if(message instanceof Error)
        message = message.message;
    if(!level)
        level = "error";
    let position = 'center';
    let gravity = 'top';

    switch(level) {
    case "info":
        position = 'right';
        gravity = 'bottom';
        break;
    case "warning":
        break;
    case "kicked":
        level = "error";
        break;
    }

    /** @ts-ignore */
    Toastify({
        text: message,
        duration: 4000,
        close: true,
        position: position,
        gravity: gravity,
        className: level,
    }).showToast();
}

/**
 * @param {unknown} message
 */
function displayWarning(message) {
    return displayError(message, "warning");
}

/**
 * @param {unknown} message
 */
function displayMessage(message) {
    return displayError(message, "info");
}

document.getElementById('loginform').onsubmit = async function(e) {
    e.preventDefault();

    let form = this;
    if(!(form instanceof HTMLFormElement))
        throw new Error('Bad type for loginform');

    setVisibility('passwordform', true);

    presentRequested = {
        audio: getInputElement('join-mic').checked,
        video: getInputElement('join-camera').checked,
    };
    getInputElement('join-mic').checked = false;
    getInputElement('join-camera').checked = false;
    setJoinError('');

    // Connect to the server, gotConnected will join.
    serverConnect();
};


/** @type{CameraTest} */
let cameraTest = null;
let testRunning = false;

/** @returns {{audio: boolean, video: boolean}} */
function testSelection() {
    let mode = getSelectElement('test-mode').value;
    return {audio: mode !== 'video', video: mode !== 'audio'};
}

function showTestStatus() {
    let stream = /** @type {MediaStream|null} */(cameraTest?.video.srcObject);
    let hasVideo = !!stream?.getVideoTracks().length;
    let hasAudio = !!stream?.getAudioTracks().length;
    let state = hasVideo && hasAudio ? 'Caméra visible. Micro détecté.' :
                hasVideo ? 'Caméra visible.' :
                hasAudio ? 'Micro détecté. Observe le niveau quand tu parles.' :
                'Test arrêté.';
    document.getElementById('test-status').textContent = state;
    document.getElementById('test-video').hidden = !hasVideo;
    document.getElementById('test-fft').hidden = !hasAudio;
}

getButtonElement('run-test').onclick = async function() {
    if(testRunning)
        return;
    let details = /** @type {HTMLDetailsElement} */(document.getElementById('test-camera'));
    let status = document.getElementById('test-status');
    if(!cameraTest) {
        cameraTest = new CameraTest(
            /** @type {HTMLVideoElement} */(document.getElementById('test-video')),
            /** @type {HTMLCanvasElement} */(document.getElementById('test-fft')),
            getSelectElement('test-videoselect'),
            getSelectElement('test-audioselect'),
        );
    }
    testRunning = true;
    getButtonElement('run-test').disabled = true;
    status.textContent = 'Demande d’accès aux appareils…';
    try {
        await cameraTest.stopStream();
        await cameraTest.setAnalyser();
        let selection = testSelection();
        await cameraTest.setMediaChoices(selection);
        cameraTest.reflectSettings();
        if(!details.open)
            return;
        await cameraTest.setStream(true, selection);
        if(details.open) {
            await cameraTest.setAnalyser();
            showTestStatus();
        } else {
            await cameraTest.stopStream();
        }
    } catch(error) {
        console.warn(error);
        await cameraTest.stopStream();
        await cameraTest.setAnalyser();
        showTestStatus();
        if(details.open) {
            status.textContent = error.name === 'NotAllowedError' ?
                'Accès refusé. Autorise l’appareil dans le navigateur ou essaie l’autre appareil.' :
                'Appareil indisponible. Essaie un autre appareil ou rejoins le salon sans le test.';
        }
    } finally {
        testRunning = false;
        getButtonElement('run-test').disabled = false;
    }
};

document.getElementById('test-camera').ontoggle = async function() {
    if(this instanceof HTMLDetailsElement && !this.open && cameraTest) {
        await cameraTest.stopStream();
        await cameraTest.setAnalyser();
        showTestStatus();
    }
};

for(let [id, key] of [['test-videoselect', 'video'], ['test-audioselect', 'audio']]) {
    getSelectElement(id).onchange = async function() {
        if(testRunning || !cameraTest)
            return;
        updateSettings({[key]: getSelectElement(id).value});
        try {
            await cameraTest.setStream(false, testSelection());
            await cameraTest.setAnalyser();
            showTestStatus();
        } catch(error) {
            await cameraTest.setAnalyser();
            showTestStatus();
            document.getElementById('test-status').textContent = 'Appareil indisponible. Relance le test avec un autre appareil.';
        }
    };
}

getButtonElement('disconnectbutton').onclick = function(e) {
    serverConnection.close();
    selectCallPanel(null);
};

getButtonElement('hand-toggle').onclick = () => {
    const user = serverConnection.users[serverConnection.id];
    if(user)
        setHandRaised(speakingTicket(user.data.raisehand) === null);
};

const callPanels = {
    chat: {panel: 'left', button: 'chat-toggle', title: 'chat-title'},
    participants: {panel: 'left-sidebar', button: 'sidebarCollapse', title: 'participants-title'},
    settings: {panel: 'sidebarnav', button: 'openside', title: 'settings-title', restore: 'room-tools-toggle'},
};
let currentCallPanel = null;

/**
 * @param {string} name
 * @param {boolean} [restoreFocus]
 */
function selectCallPanel(name, restoreFocus) {
    let previous = currentCallPanel;
    currentCallPanel = name === previous ? null : name;
    let visible = currentCallPanel;
    document.body.classList.toggle('ux-panel-open', !!visible);
    for(let key in callPanels) {
        let {panel, button, title} = callPanels[key];
        let selected = key === visible;
        document.getElementById(panel).hidden = !selected;
        document.getElementById(button).setAttribute('aria-expanded', String(selected));
        if(key === 'chat')
            setVisibility(panel, selected);
        if(selected)
            document.getElementById(title).focus();
    }
    if(!visible && restoreFocus && previous)
        document.getElementById(callPanels[previous].restore || callPanels[previous].button).focus();
    resizePeers();
    scheduleReconsiderDownRate();
}

for(let key in callPanels) {
    getButtonElement(callPanels[key].button).onclick = function() {
        setRoomToolsOpen(false);
        selectCallPanel(key, true);
    };
}
getButtonElement('clodeside').onclick = () => selectCallPanel(null, true);
getButtonElement('close-chat').onclick = () => selectCallPanel(null, true);
getButtonElement('close-participants').onclick = () => selectCallPanel(null, true);
document.getElementById('show-chat').onclick = () => selectCallPanel('chat', true);
document.getElementById('collapse-video').onclick = () => selectCallPanel('chat', true);
document.getElementById('show-video').onclick = () => selectCallPanel(null, true);
document.addEventListener('keydown', event => {
    if(event.key !== 'Escape' || document.querySelector('dialog[open]'))
        return;
    if(!toolsPanel.hidden) {
        setRoomToolsOpen(false);
        getButtonElement('room-tools-toggle').focus();
        return;
    }
    if(!reactionPicker.hidden) {
        setReactionPicker(false);
        reactionsToggle.focus();
        return;
    }
    if(currentCallPanel)
        selectCallPanel(null, true);
});

async function serverConnect() {
    if(document.body.dataset.callState === 'connecting')
        return;
    if(token)
        setVisibility('login-container', true);
    document.body.dataset.callState = 'connecting';
    updateCallStatus();
    if(serverConnection && serverConnection.socket)
        serverConnection.close();
    serverConnection = new ServerConnection();
    serverConnection.onconnected = gotConnected;
    serverConnection.onbeforemove = () => {
        const media = localMediaState();
        presentRequested = {audio: media.audio, video: media.video, muted: !media.micOn};
    };
    serverConnection.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    serverConnection.onpeerconnection = onPeerConnection;
    serverConnection.onclose = gotClose;
    serverConnection.ondownstream = gotDownStream;
    serverConnection.onuser = gotUser;
    serverConnection.onjoined = gotJoined;
    serverConnection.onchat = addToChatbox;
    serverConnection.onusermessage = gotUserMessage;
    serverConnection.onfiletransfer = gotFileTransfer;

    let url = groupStatus.endpoint;
    if(!url) {
        console.warn("no endpoint in status");
        url = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`;
    }

    try {
        await serverConnection.connect(url);
    } catch(e) {
        console.error(e);
        setConnected(false);
        setJoinError('Connexion au salon impossible. Réessaie dans un instant.');
    }
}

async function start() {
    try {
        let r = await fetch(".status")
        if(!r.ok)
            throw new Error(`${r.status} ${r.statusText}`);
        groupStatus = await r.json()
    } catch(e) {
        console.error(e);
        displayWarning("Couldn't fetch status: " + e);
        groupStatus = {};
    }

    if(groupStatus.name) {
        group = groupStatus.name;
    } else {
        console.warn("no group name in status");
        group = decodeURIComponent(
            location.pathname.replace(/^\/[a-z]*\//, '').replace(/\/$/, ''),
        );
    }

    // Disable simulcast on Firefox by default, it's buggy.
    if(isFirefox())
        getSelectElement('simulcastselect').value = 'off';

    let parms = new URLSearchParams(window.location.search);
    if(window.location.search)
        window.history.replaceState(null, '', window.location.pathname);
    setTitle(groupStatus.displayName || capitalise(group));

    await addFilters();
    configureBackgroundImageControl();
    await setMediaChoices(false);
    reflectSettings();

    if(parms.has('token'))
        token = parms.get('token');

    if(token) {
        await serverConnect();
    } else if(groupStatus.authPortal) {
        window.location.href = groupStatus.authPortal;
    } else {
        setVisibility('login-container', true);
        document.getElementById('username').focus()
    }
    setViewportHeight();
}

let roomLayoutObserver = new ResizeObserver(() => {
    const style = document.body.style;
    style.setProperty('--ux-header-height', document.querySelector('.ux-header').getBoundingClientRect().height + 'px');
    style.setProperty('--ux-toolbar-height', document.getElementById('call-controls').getBoundingClientRect().height + 'px');
    resizePeers();
});
roomLayoutObserver.observe(document.querySelector('.ux-header'));
roomLayoutObserver.observe(document.getElementById('call-controls'));
initializeRoomTools();
initializeCallDiagnostics();
initializeMeetingTools();
initializeLobby();
initializeShareAnnotations();
initializeSharedBoard();
initializeBreakouts();
start();

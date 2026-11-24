'use strict';

let networkTimer;
let consecutiveBadSamples = 0;
let networkSamplePending = false;
/** @type {Map<string, {received: number, lost: number}>} */
let previousNetworkCounters = new Map();
let showCaptions = false;
let captioningEnabled = false;

/** @param {boolean} [enabled] */
function reflectCaptioning(enabled) {
    if(enabled !== undefined)
        captioningEnabled = enabled;
    const available = Object.values(serverConnection?.users || {}).some(user =>
        user.permissions.includes('caption-on-demand'),
    );
    document.getElementById('captioning-status').hidden = !captioningEnabled || !available;
    const control = getButtonElement('captioning-toggle');
    control.hidden = !available || !serverConnection?.permissions.includes('op');
    control.textContent = captioningEnabled ? 'Arrêter la transcription' : 'Activer la transcription française';
    control.setAttribute('aria-pressed', String(captioningEnabled));
}

function resetNetworkSample() {
    previousNetworkCounters.clear();
    consecutiveBadSamples = 0;
    document.getElementById('network-summary').hidden = true;
    document.getElementById('network-enable-low').hidden = true;
    document.getElementById('network-message').textContent = 'En attente de données médias.';
    document.getElementById('network-metrics').replaceChildren();
}

/** @param {string} label @param {number} value @param {string} unit */
function appendNetworkMetric(label, value, unit) {
    if(!Number.isFinite(value))
        return;
    const name = document.createElement('dt');
    name.textContent = label;
    const reading = document.createElement('dd');
    reading.textContent = Math.round(value) + ' ' + unit;
    document.getElementById('network-metrics').append(name, reading);
}

async function sampleNetwork() {
    if(networkSamplePending || !serverConnection?.group)
        return;
    const current = serverConnection;
    networkSamplePending = true;
    try {
        const streams = [...Object.values(current.up), ...Object.values(current.down)];
        const reports = await Promise.allSettled(streams.map(stream => stream.pc.getStats()));
        if(serverConnection !== current || !current.group)
            return;
        const next = new Map();
        let delay = NaN;
        let audioJitter = NaN;
        let audioLoss = NaN;
        let videoLoss = NaN;
        function maxKnown(a, b) {
            return Number.isFinite(a) ? Math.max(a, b) : b;
        }
        for(const [i, result] of reports.entries()) {
            if(result.status !== 'fulfilled')
                continue;
            const report = result.value;
            for(const stat of report.values()) {
                if(stat.type === 'transport' && stat.selectedCandidatePairId) {
                    const pair = report.get(stat.selectedCandidatePairId);
                    if(Number.isFinite(pair?.currentRoundTripTime))
                        delay = maxKnown(delay, pair.currentRoundTripTime * 1000);
                }
                if(stat.type !== 'inbound-rtp' || !Number.isFinite(stat.packetsReceived))
                    continue;
                const track = streams[i].id + '/' + stat.id;
                const received = stat.packetsReceived;
                const lost = stat.packetsLost || 0;
                next.set(track, {received, lost});
                if(stat.kind === 'audio' && Number.isFinite(stat.jitter))
                    audioJitter = maxKnown(audioJitter, stat.jitter * 1000);
                const old = previousNetworkCounters.get(track);
                if(!old || received <= old.received)
                    continue;
                const missing = Math.max(0, lost - old.lost);
                const fraction = 100 * missing / (received - old.received + missing);
                if(stat.kind === 'audio')
                    audioLoss = maxKnown(audioLoss, fraction);
                else
                    videoLoss = maxKnown(videoLoss, fraction);
            }
        }
        previousNetworkCounters = next;
        const bad = delay > 400 || audioJitter > 60 || audioLoss > 5 || videoLoss > 10;
        consecutiveBadSamples = bad ? consecutiveBadSamples + 1 : 0;
        const metrics = document.getElementById('network-metrics');
        metrics.replaceChildren();
        appendNetworkMetric('Latence aller-retour', delay, 'ms');
        appendNetworkMetric('Variation du délai audio', audioJitter, 'ms');
        appendNetworkMetric('Pertes audio reçues', audioLoss, '%');
        appendNetworkMetric('Pertes vidéo reçues', videoLoss, '%');
        document.getElementById('network-message').textContent = !metrics.childElementCount ?
            'En attente de données médias.' : bad ? 'Les médias peuvent être interrompus par le réseau.' : 'Aucun signe de dégradation récente.';
        document.getElementById('network-summary').hidden = consecutiveBadSamples < 2;
        document.getElementById('network-enable-low').hidden = !bad || !!getSettings().lowBandwidth;
    } finally {
        networkSamplePending = false;
    }
}

/** @param {boolean} connected */
function monitorCallDiagnostics(connected) {
    clearInterval(networkTimer);
    resetNetworkSample();
    const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('network-dialog'));
    if(connected) {
        networkTimer = setInterval(sampleNetwork, 2500);
    } else {
        if(dialog.open)
            dialog.close();
        setCaption(null);
        reflectCaptioning(false);
    }
}

function initializeCallDiagnostics() {
    const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('network-dialog'));
    const open = () => {
        setRoomToolsOpen(false);
        dialog.showModal();
        sampleNetwork();
    };
    getButtonElement('network-toggle').onclick = open;
    getButtonElement('network-summary').onclick = open;
    getButtonElement('network-enable-low').onclick = () => {
        if(!getSettings().lowBandwidth)
            getButtonElement('low-bandwidth').click();
        document.getElementById('network-enable-low').hidden = true;
    };
    const captions = getButtonElement('captions-toggle');
    captions.onclick = () => {
        showCaptions = !showCaptions;
        captions.setAttribute('aria-pressed', String(showCaptions));
        if(!showCaptions)
            setCaption(null);
    };
    getButtonElement('captioning-toggle').onclick = () => serverConnection.groupAction(
        'setdata', {captioningEnabled: !captioningEnabled},
    );
}

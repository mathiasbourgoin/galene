// The camera switch idea was inspired by nahu02/hybrid-meeting-buddies.
'use strict';

(() => {
    const button = getButtonElement('flip-camera');
    if (!navigator.mediaDevices?.enumerateDevices)
        return;

    // Avoid presenting this as an extra primary control on desktop.
    if (matchMedia('(pointer: coarse)').matches)
        button.hidden = false;

    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const stream = findUpMedia('camera');
            const track = stream?.stream?.getVideoTracks().find(t => t.readyState === 'live');
            if (!track) {
                displayWarning('Active ta caméra avant de la changer.');
                return;
            }
            const cameras = (await navigator.mediaDevices.enumerateDevices())
                .filter(device => device.kind === 'videoinput' && device.deviceId && device.deviceId !== 'default');
            if (cameras.length < 2) {
                displayWarning('Une seule caméra est disponible sur cet appareil.');
                return;
            }
            const current = track.getSettings().deviceId || getSelectElement('videoselect').value;
            const index = cameras.findIndex(camera => camera.deviceId === current);
            const next = cameras[(index + 1) % cameras.length];
            const select = getSelectElement('videoselect');
            if (![...select.options].some(option => option.value === next.deviceId))
                select.add(new Option(next.label || 'Caméra', next.deviceId));
            select.value = next.deviceId;
            updateSettings({video: select.value});
            await replaceCameraStream();
        } catch (error) {
            console.error('Unable to change camera', error);
            displayWarning('Impossible de changer de caméra.');
        } finally {
            button.disabled = false;
        }
    });
})();

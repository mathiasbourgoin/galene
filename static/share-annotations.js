'use strict';

let annotationOwner = '';
/** @type {{owner:string, pointer:number, mode:string, points:number[][], preview:SVGSVGElement}|null} */
let annotationDraft = null;

function currentShareOwner() {
    return stage.querySelector(':scope > .peer')?.getAttribute('data-share-owner') || '';
}

/** @param {string} owner @param {string} author */
function mayAnnotate(owner, author) {
    return !!owner && !!serverConnection?.users[author] &&
        (owner === author || serverConnection.users[owner]?.data.allowAnnotations === true);
}

function refreshAnnotations() {
    const owner = currentShareOwner();
    const own = !!owner && owner === serverConnection.id;
    const allowed = mayAnnotate(owner, serverConnection.id);
    const select = getSelectElement('annotation-mode');
    if(annotationOwner !== owner || !allowed) {
        annotationDraft?.preview?.remove();
        annotationDraft = null;
        select.value = '';
    }
    annotationOwner = owner;
    document.getElementById('annotation-control').hidden = !allowed;
    document.getElementById('annotation-permission').hidden = !own;
    getInputElement('allow-annotations').checked = own && serverConnection.users[owner]?.data.allowAnnotations === true;
    stage.toggleAttribute('data-annotation', allowed && !!select.value);
}

/** @param {number[]} point */
function validAnnotationPoint(point) {
    return Array.isArray(point) && point.length === 2 &&
        point.every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

/**
 * @param {string} mode
 * @param {number[][]} points
 * @param {SVGSVGElement} [reuse]
 */
function drawShareAnnotation(mode, points, reuse) {
    const peer = /** @type {HTMLElement} */ (stage.querySelector(':scope > .peer'));
    if(!peer)
        return null;
    const frame = shareVideoBounds(peer);
    if(!frame)
        return null;
    const bounds = peer.getBoundingClientRect();
    const namespace = 'http://www.w3.org/2000/svg';
    const mark = reuse || document.createElementNS(namespace, 'svg');
    mark.classList.add('ux-annotation');
    mark.setAttribute('viewBox', '0 0 ' + frame.width + ' ' + frame.height);
    mark.setAttribute('aria-hidden', 'true');
    mark.style.left = (frame.x - bounds.x) + 'px';
    mark.style.top = (frame.y - bounds.y) + 'px';
    mark.style.width = frame.width + 'px';
    mark.style.height = frame.height + 'px';
    const vertices = points.map(([x,y]) => [Math.round(x * frame.width), Math.round(y * frame.height)]);
    let segments;
    if(mode === 'arrow') {
        const [x0, y0] = vertices[0];
        const [x, y] = vertices[vertices.length - 1];
        const angle = Math.atan2(y - y0, x - x0);
        const head = direction => [x - 19 * Math.cos(angle + direction), y - 19 * Math.sin(angle + direction)];
        segments = [vertices.slice(0,1).concat([[x, y]]), [head(.5), [x, y], head(-.5)]];
    } else {
        segments = [vertices];
    }
    mark.replaceChildren(...segments.map(segment => {
        const path = document.createElementNS(namespace, 'polyline');
        path.setAttribute('points', segment.map(point => point.join(',')).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', mode === 'arrow' ? '#f24736' : '#ffe158');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-width', mode === 'arrow' ? '4' : '13');
        path.setAttribute('opacity', mode === 'arrow' ? '1' : '.62');
        return path;
    }));
    if(!reuse)
        peer.appendChild(mark);
    return mark;
}

/**
 * @param {string} author
 * @param {any} value
 */
function receiveShareAnnotation(author, value) {
    const owner = currentShareOwner();
    if(!value || value.owner !== owner || !mayAnnotate(owner, author) ||
       !['highlight', 'arrow'].includes(value.mode) || !Array.isArray(value.points) ||
       value.points.length < 2 || value.points.length > 64 || !value.points.every(validAnnotationPoint))
        return;
    const overlays = stage.querySelectorAll('.ux-annotation');
    if(overlays.length >= 24)
        overlays[0].remove();
    const mark = drawShareAnnotation(value.mode, value.points);
    if(mark)
        setTimeout(() => mark.remove(), 10000);
}

/** @param {PointerEvent} event */
function annotationPoint(event) {
    const peer = /** @type {HTMLElement} */ (stage.querySelector(':scope > .peer'));
    if(!peer)
        return null;
    const frame = shareVideoBounds(peer);
    if(!frame)
        return null;
    return [Math.min(1, Math.max(0, (event.clientX - frame.x) / frame.width)),
        Math.min(1, Math.max(0, (event.clientY - frame.y) / frame.height))];
}

function initializeShareAnnotations() {
    const select = getSelectElement('annotation-mode');
    select.onchange = () => {
        if(select.value && pointerEnabled) {
            pointerEnabled = false;
            updatePresentationLayout();
        }
        stage.toggleAttribute('data-annotation', !!select.value);
        setRoomToolsOpen(false);
    };
    getInputElement('allow-annotations').onchange = () => serverConnection.userAction(
        'setdata', serverConnection.id, {allowAnnotations: getInputElement('allow-annotations').checked},
    );
    stage.addEventListener('pointerdown', event => {
        const mode = select.value;
        const owner = currentShareOwner();
        if(!mode || !mayAnnotate(owner, serverConnection.id) || !(event.target instanceof HTMLVideoElement) || event.button !== 0)
            return;
        const point = annotationPoint(event);
        if(!point)
            return;
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        annotationDraft?.preview?.remove();
        annotationDraft = {owner, pointer: event.pointerId, mode, points: [point], preview: null};
    });
    stage.addEventListener('pointermove', event => {
        const draft = annotationDraft;
        if(!draft || event.pointerId !== draft.pointer)
            return;
        const point = annotationPoint(event);
        if(!point)
            return;
        if(draft.mode === 'arrow')
            draft.points.length = 1;
        else if(draft.points.length >= 64)
            draft.points.pop();
        draft.points.push(point);
        draft.preview = drawShareAnnotation(draft.mode, draft.points, draft.preview);
    });
    stage.addEventListener('pointerup', event => {
        const draft = annotationDraft;
        if(!draft || draft.pointer !== event.pointerId)
            return;
        annotationDraft = null;
        draft.preview?.remove();
        if(draft.points.length < 2 || !mayAnnotate(draft.owner, serverConnection.id))
            return;
        const value = {owner: draft.owner, mode: draft.mode, points: draft.points};
        serverConnection.userMessage('share-annotation', '', value, true);
        receiveShareAnnotation(serverConnection.id, value);
    });
    stage.addEventListener('lostpointercapture', event => {
        if(annotationDraft?.pointer === event.pointerId) {
            annotationDraft.preview?.remove();
            annotationDraft = null;
        }
    });
}

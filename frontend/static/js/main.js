(function () {
    var map;
    var layers = [];
    var startMarker = null;
    var destinationMarker = null;
    var inspectionMarker = null;
    var friendMarkers = {};
    var meetpointMarker = null;
    var selectingStart = false;

    function $(id) {
        return document.getElementById(id);
    }

    var logEl = $('status-log');
    var scriptInput = $('script-input');
    var algorithmSelect = $('algorithm-select');

    var searchInput = $('search-query');
    var searchButton = $('search-place');
    var resultsList = $('search-results');
    var selectStartButton = $('select-start');
    var geolocationButton = $('use-geolocation');
    var clearStartButton = $('clear-start');
    var clearDestinationButton = $('clear-destination');
    var openRouteButton = $('open-route');
    var transportSelect = $('transport-select');
    var routeModeSelect = $('route-mode');
    var trafficModeSelect = $('traffic-mode');
    var outputSelect = $('output-select');
    var filtersControls = document.querySelectorAll('#filters-controls input[type="checkbox"]');
    var needAltitudesToggle = $('need-altitudes');
    var allowLockedToggle = $('allow-locked-roads');
    var alternativeInput = $('alternative-count');
    var ptOptionsBlock = $('pt-options');
    var ptOptionCheckboxes = ptOptionsBlock ? ptOptionsBlock.querySelectorAll('input[type="checkbox"]') : [];
    var optionsBlock = $('options-block');
    var trafficRow = $('traffic-row');
    var alternativeRow = $('alternative-row');

    var friendsToggle = $('friends-toggle');
    var friendsPanel = $('friends-panel');
    var friendsList = $('friends-list');
    var pickupControls = $('pickup-controls');
    var pickupEnable = $('pickup-enable');
    var pickupFriendSelect = $('pickup-friend');
    var arrivalTimeInput = $('arrival-time');
    var calculateScheduleButton = $('calculate-schedule');
    var scheduleResults = $('schedule-results');

    var pointInfoEl = $('point-info');
    var pointInfoName = $('point-info-name');
    var pointInfoAddress = $('point-info-address');
    var pointInfoCoords = $('point-info-coords');
    var setPointStartButton = $('set-point-start');
    var setPointDestinationButton = $('set-point-destination');

    var routeInfoEl = $('route-info');
    var routeSummaryEl = $('route-summary');
    var routeStepsBody = document.querySelector('#route-steps tbody');

    var config = window.APP_CONFIG || {};
    var apiKey = (config.gisApiKey || '').trim();
    var enableRaster = Boolean(config.enableRasterLayer);

        var selectedDestination = null;
    var destinationLabel = 'Финиш';
    var startPoint = null;
    var startLabel = 'Старт';
    var lastInspectedPoint = null;

    var scheduleData = null;

    var friendsLoaded = false;
    var friendsLoading = false;
    var friendsLoadPromise = null;
    var friendsData = [];
    var targetZPoint = null;
    var activeFriendId = null;
    var friendStates = {};
    var meetpointState = {
        key: null,
        point: null,
        pending: null,
        meta: null,
        error: null,
        lastLoggedSignature: null
    };
    var meetpointRecalcTimer = null;
    var DEFAULT_MEETPOINT_TYPE = 'minisum';
    function collectParticipantPoints() {
        var points = [];
        if (startPoint && typeof startPoint.lat === 'number' && typeof startPoint.lng === 'number') {
            var userLat = Number(startPoint.lat);
            var userLng = Number(startPoint.lng);
            if (!Number.isNaN(userLat) && !Number.isNaN(userLng)) {
                points.push({lat: userLat, lng: userLng});
            }
        }
        for (var i = 0; i < friendsData.length; i += 1) {
            var friend = friendsData[i];
            if (!friend || friend.friend_id == null) {
                continue;
            }
            var state = ensureFriendState(friend, i);
            if (state && state.included !== false) {
                var lat = Number(friend.x_coord);
                var lng = Number(friend.y_coord);
                if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                    points.push({lat: lat, lng: lng});
                }
            }
        }
        return points;
    }

    function computeGeometricMedian(points, maxIterations, tolerance) {
        if (!points || points.length === 0) {
            return null;
        }
        if (points.length === 1) {
            return {lat: points[0].lat, lng: points[0].lng};
        }
        maxIterations = maxIterations || 80;
        tolerance = tolerance || 1e-6;
        var current = {lat: 0, lng: 0};
        for (var i = 0; i < points.length; i += 1) {
            current.lat += points[i].lat;
            current.lng += points[i].lng;
        }
        current.lat /= points.length;
        current.lng /= points.length;
        var epsilon = 1e-12;
        for (var iter = 0; iter < maxIterations; iter += 1) {
            var numLat = 0;
            var numLng = 0;
            var denom = 0;
            var coincident = 0;
            for (var j = 0; j < points.length; j += 1) {
                var point = points[j];
                var diffLat = current.lat - point.lat;
                var diffLng = current.lng - point.lng;
                var distance = Math.sqrt(diffLat * diffLat + diffLng * diffLng);
                if (distance < epsilon) {
                    coincident += 1;
                    numLat += point.lat;
                    numLng += point.lng;
                    denom += 1;
                } else {
                    var weight = 1 / distance;
                    numLat += point.lat * weight;
                    numLng += point.lng * weight;
                    denom += weight;
                }
            }
            if (denom === 0) {
                return {lat: current.lat, lng: current.lng};
            }
            var next = {lat: numLat / denom, lng: numLng / denom};
            if (Math.sqrt((next.lat - current.lat) * (next.lat - current.lat) + (next.lng - current.lng) * (next.lng - current.lng)) < tolerance) {
                return next;
            }
            current = next;
        }
        return current;
    }

    function normalizeMeetpointType(value) {
        var normalized = (value || '').toLowerCase();
        if (normalized !== 'minimax' && normalized !== 'minisum') {
            return DEFAULT_MEETPOINT_TYPE;
        }
        return normalized;
    }

    function getConfiguredMeetpointType() {
        if (config && typeof config.meetpointType === 'string' && config.meetpointType.trim()) {
            return normalizeMeetpointType(config.meetpointType.trim());
        }
        return DEFAULT_MEETPOINT_TYPE;
    }

    function getFriendInitial(friend) {
        if (friend && typeof friend.name === 'string' && friend.name.trim()) {
            return friend.name.trim().charAt(0).toUpperCase();
        }
        if (friend && friend.friend_id != null) {
            var friendId = String(friend.friend_id);
            if (friendId) {
                return friendId.charAt(0).toUpperCase();
            }
        }
        return '•';
    }

    function createFriendIcon(color, label) {
        var symbol = (label || '').trim();
        if (symbol.length > 1) {
            symbol = symbol.charAt(0);
        }
        if (!symbol) {
            symbol = '•';
        }
        return DG.divIcon({
            className: 'friend-marker',
            iconAnchor: [12, 12],
            iconSize: [24, 24],
            html: '<div class="friend-marker__dot" style="background-color:' + color + ';">' + escapeHtml(symbol) + '</div>'
        });
    }

    function refreshFriendMarkers() {
        if (!map) {
            return;
        }
        var activeMarkers = {};
        friendsData.forEach(function (friend, index) {
            if (!friend || friend.friend_id == null) {
                return;
            }
            var friendId = String(friend.friend_id);
            var state = ensureFriendState(friend, index);
            if (state && state.included === false) {
                return;
            }
            var lat = Number(friend.x_coord);
            var lng = Number(friend.y_coord);
            if (Number.isNaN(lat) || Number.isNaN(lng)) {
                return;
            }
            activeMarkers[friendId] = true;
            var color = (state && state.color) || '#1976d2';
            var marker = friendMarkers[friendId];
            var icon = createFriendIcon(color, getFriendInitial(friend));
            if (!marker) {
                marker = DG.marker([lat, lng], {
                    title: friend.name || ('Друг #' + friendId),
                    draggable: true,
                    icon: icon
                });
                (function (trackedId) {
                    marker.on('dragend', function (event) {
                        var entry = getFriendDataById(trackedId);
                        if (!entry) {
                            return;
                        }
                        var position = event.target.getLatLng();
                        entry.friend.x_coord = Number(position.lat.toFixed(6));
                        entry.friend.y_coord = Number(position.lng.toFixed(6));
                        var entryState = ensureFriendState(entry.friend, entry.index);
                        if (entryState) {
                            entryState.routes = {};
                        }
                        scheduleMeetpointRecalculation(true);
                        renderFriendsList();
                        refreshFriendMarkers();
                        log('Координаты обновлены для ' + (entry.friend.name || ('друга #' + trackedId)) + ': ' + position.lat.toFixed(6) + ', ' + position.lng.toFixed(6));
                    });
                })(friendId);
                marker.addTo(map);
                friendMarkers[friendId] = marker;
            } else {
                marker.setLatLng([lat, lng]);
                marker.setIcon(icon);
                if (!map.hasLayer(marker)) {
                    marker.addTo(map);
                }
            }
        });
        Object.keys(friendMarkers).forEach(function (friendId) {
            if (!Object.prototype.hasOwnProperty.call(activeMarkers, friendId)) {
                var marker = friendMarkers[friendId];
                if (marker && map && map.hasLayer(marker)) {
                    map.removeLayer(marker);
                }
                delete friendMarkers[friendId];
            }
        });
    }

    function updateMeetpointMarker(point, meta) {
        if (!map) {
            return;
        }
        if (meetpointMarker && map.hasLayer(meetpointMarker)) {
            map.removeLayer(meetpointMarker);
        }
        meetpointMarker = null;
        if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number') {
            return;
        }
        meetpointMarker = DG.circleMarker([point.lat, point.lng], {
            radius: 9,
            color: '#b71c1c',
            fillColor: '#ff1744',
            fillOpacity: 0.95,
            weight: 3,
            opacity: 1
        });
        var popupLines = [
            '<strong>\u0422\u043e\u0447\u043a\u0430 \u0432\u0441\u0442\u0440\u0435\u0447\u0438 Z</strong>',
            '\u041a\u043e\u043e\u0440\u0434\u0438\u043d\u0430\u0442\u044b: ' + point.lat.toFixed(6) + ', ' + point.lng.toFixed(6)
        ];
        if (meta && meta.source) {
            popupLines.push('\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a: ' + escapeHtml(String(meta.source)));
        }
        if (meta && meta.method) {
            popupLines.push('\u041c\u0435\u0442\u043e\u0434: ' + escapeHtml(String(meta.method)));
        } else if (meta && meta.type_of_meetpoint) {
            popupLines.push('\u041c\u0435\u0442\u043e\0434: ' + escapeHtml(String(meta.type_of_meetpoint)));
        }
        meetpointMarker.bindPopup(popupLines.join('<br>'));
        meetpointMarker.addTo(map);
    }

    function collectMeetpointParticipants() {
        var participants = [];
        if (startPoint && typeof startPoint.lat === 'number' && typeof startPoint.lng === 'number') {
            var userLat = Number(startPoint.lat);
            var userLng = Number(startPoint.lng);
            if (!Number.isNaN(userLat) && !Number.isNaN(userLng)) {
                participants.push({
                    id: 'user',
                    lat: userLat,
                    lng: userLng,
                    transport: transportSelect ? transportSelect.value : 'driving'
                });
            }
        }
        for (var i = 0; i < friendsData.length; i += 1) {
            var friend = friendsData[i];
            if (!friend || friend.friend_id == null) {
                continue;
            }
            var state = ensureFriendState(friend, i);
            if (state && state.included !== false) {
                var lat = Number(friend.x_coord);
                var lng = Number(friend.y_coord);
                if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                    participants.push({
                        id: 'friend:' + String(friend.friend_id),
                        lat: lat,
                        lng: lng,
                        transport: getFriendTransportMode(friend, i)
                    });
                }
            }
        }
        return participants;
    }

    function buildMeetpointPayload() {
        var participants = collectMeetpointParticipants();
        if (!participants.length) {
            return null;
        }
        var payload = {
            participants: participants,
            type_of_meetpoint: getConfiguredMeetpointType(),
            has_destination: false
        };
        if (selectedDestination && selectedDestination.point && typeof selectedDestination.point.lat === 'number' && typeof selectedDestination.point.lng === 'number') {
            var destLat = Number(selectedDestination.point.lat);
            var destLng = Number(selectedDestination.point.lng);
            if (!Number.isNaN(destLat) && !Number.isNaN(destLng)) {
                payload.destination = {
                    lat: destLat,
                    lng: destLng,
                    transport: transportSelect ? transportSelect.value : 'driving'
                };
                payload.has_destination = true;
            }
        }
        return payload;
    }

    function getMeetpointCacheKey(payload) {
        if (!payload) {
            return null;
        }
        return JSON.stringify(payload);
    }

    function logMeetpointMeta(meta) {
        meta = meta || {};
        var source = meta.source || 'unknown';
        var fallback = Boolean(meta.fallback_used);
        var signature = source + '|' + (fallback ? '1' : '0');
        if (meetpointState.lastLoggedSignature !== signature) {
            meetpointState.lastLoggedSignature = signature;
            var message = 'Точка встречи рассчитана: ' + source;
            if (fallback && meta.fallback_reason) {
                message += ' (' + meta.fallback_reason + ')';
            } else if (fallback) {
                message += ' (fallback)';
            }
            log(message);
        }
    }

    function requestMeetpointUpdate(force) {
        var payload = buildMeetpointPayload();
        if (!payload) {
            meetpointState.key = null;
            meetpointState.point = null;
            meetpointState.meta = null;
            meetpointState.error = null;
            meetpointState.lastLoggedSignature = null;
            meetpointState.pending = null;
            targetZPoint = null;
            return Promise.resolve(null);
        }

        var cacheKey = getMeetpointCacheKey(payload);
        if (!force) {
            if (meetpointState.pending && meetpointState.key === cacheKey) {
                return meetpointState.pending;
            }
            if (meetpointState.point && meetpointState.key === cacheKey) {
                return Promise.resolve(meetpointState.point);
            }
        }

        meetpointState.key = cacheKey;
        meetpointState.error = null;
        var requestKey = cacheKey;

        var request = fetch('/api/meetpoint', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }).then(function (response) {
            if (!response.ok) {
                return response.json().catch(function () { return {}; }).then(function (data) {
                    var message = data && data.error ? String(data.error) : ('HTTP ' + response.status);
                    throw new Error(message);
                });
            }
            return response.json();
        }).then(function (data) {
            if (meetpointState.key !== requestKey) {
                return meetpointState.point || null;
            }
            var meetpoint = data && data.meetpoint;
            if (!meetpoint || typeof meetpoint.lat === 'undefined' || typeof meetpoint.lng === 'undefined') {
                throw new Error('Неверный ответ meetpoint');
            }
            var lat = Number(meetpoint.lat);
            var lng = Number(meetpoint.lng);
            if (Number.isNaN(lat) || Number.isNaN(lng)) {
                throw new Error('Некорректные координаты meetpoint');
            }
            var point = {lat: lat, lng: lng};
            meetpointState.point = point;
            meetpointState.meta = data.meta || {};
            meetpointState.error = null;
            targetZPoint = point;
            logMeetpointMeta(meetpointState.meta);
            return point;
        }).catch(function (error) {
            meetpointState.error = error;
            if (meetpointState.key !== requestKey) {
                throw error;
            }
            var points = collectParticipantPoints();
            var fallback = computeGeometricMedian(points);
            if (fallback) {
                meetpointState.point = fallback;
                meetpointState.meta = {
                    source: 'geometric_median',
                    fallback_used: true,
                    fallback_reason: error && error.message ? error.message : String(error)
                };
                meetpointState.lastLoggedSignature = null;
                targetZPoint = fallback;
                log('Не удалось получить точку встречи с сервера: ' + (error && error.message ? error.message : String(error)));
                log('Используем локальную геометрическую медиану участников.');
                logMeetpointMeta(meetpointState.meta);
                return fallback;
            }
            meetpointState.point = null;
            meetpointState.meta = null;
            targetZPoint = null;
            throw error;
        }).finally(function () {
            if (meetpointState.key === requestKey) {
                meetpointState.pending = null;
            }
        });

        meetpointState.pending = request;
        return request;
    }

    function scheduleMeetpointRecalculation(force) {
        if (meetpointRecalcTimer) {
            clearTimeout(meetpointRecalcTimer);
        }
        meetpointRecalcTimer = setTimeout(function () {
            meetpointRecalcTimer = null;
            requestMeetpointUpdate(Boolean(force));
        }, 250);
    }

    function calculateDynamicTargetZ() {
        if (meetpointState.point && typeof meetpointState.point.lat === 'number' && typeof meetpointState.point.lng === 'number') {
            return {lat: meetpointState.point.lat, lng: meetpointState.point.lng};
        }
        var points = collectParticipantPoints();
        if (!points || !points.length) {
            return null;
        }
        var median = computeGeometricMedian(points);
        if (!median || Number.isNaN(median.lat) || Number.isNaN(median.lng)) {
            return null;
        }
        return {lat: median.lat, lng: median.lng};
    }

    var friendColorPalette = ['#5c6bc0', '#26a69a', '#ffb74d', '#8d6e63', '#7e57c2', '#0097a7'];
    var lastKnownTargetZKey = null;
    var pickupFriendId = '';

    var FRIEND_TRANSPORT_OPTIONS = [
        { mode: 'public_transport', label: 'Общественный транспорт', icon: '🚌' },
        { mode: 'car', label: 'Машина', icon: '🚗' },
        { mode: 'walking', label: 'Пешком', icon: '🚶' },
        { mode: 'bicycle', label: 'Велосипед', icon: '🚲' }
    ];

    function getTransportOption(mode) {
        mode = (mode || '').toLowerCase();
        for (var i = 0; i < FRIEND_TRANSPORT_OPTIONS.length; i += 1) {
            if (FRIEND_TRANSPORT_OPTIONS[i].mode === mode) {
                return FRIEND_TRANSPORT_OPTIONS[i];
            }
        }
        return FRIEND_TRANSPORT_OPTIONS[0];
    }

    function getNextTransport(mode) {
        var current = getTransportOption(mode);
        for (var i = 0; i < FRIEND_TRANSPORT_OPTIONS.length; i += 1) {
            if (FRIEND_TRANSPORT_OPTIONS[i].mode === current.mode) {
                return FRIEND_TRANSPORT_OPTIONS[(i + 1) % FRIEND_TRANSPORT_OPTIONS.length];
            }
        }
        return FRIEND_TRANSPORT_OPTIONS[0];
    }

    var FILTER_MATRIX = {
        driving: ['dirt_road', 'toll_road', 'ferry'],
        taxi: ['dirt_road', 'toll_road', 'ferry'],
        motorcycle: ['dirt_road', 'toll_road', 'ferry'],
        bicycle: ['dirt_road', 'ban_car_road', 'ban_stairway', 'ferry', 'highway'],
        scooter: ['dirt_road', 'ban_car_road', 'ban_stairway', 'ferry', 'highway'],
        walking: ['dirt_road', 'ban_stairway', 'ferry', 'highway'],
        truck: ['dirt_road', 'toll_road', 'ferry'],
        emergency: ['dirt_road', 'toll_road', 'ferry']
    };

    var FRIEND_TRANSPORT_MAP = {
        car: 'driving',
        driving: 'driving',
        taxi: 'taxi',
        public_transport: 'public_transport',
        walking: 'walking',
        pedestrian: 'walking',
        bike: 'bicycle',
        bicycle: 'bicycle',
        scooter: 'scooter',
        motorcycle: 'motorcycle',
        truck: 'truck',
        bus: 'public_transport'
    };


    function log(message) {
        if (!logEl) {
            return;
        }
        var timestamp = new Date().toISOString();
        logEl.textContent += '[' + timestamp + '] ' + message + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }


    function mapFriendTransport(mode) {
        var normalized = (mode || '').toLowerCase();
        return FRIEND_TRANSPORT_MAP[normalized] || 'driving';
    }

    function ensureFriendState(friend, index) {
        var friendIdRaw = friend && friend.friend_id;
        var friendId = friendIdRaw != null ? String(friendIdRaw) : '';
        if (!friendId) {
            return null;
        }
        var state = friendStates[friendId];
        if (!state) {
            state = {
                included: true,
                color: friendColorPalette[index % friendColorPalette.length],
                routes: {},
                transport: getTransportOption(friend && friend.mode).mode
            };
            friendStates[friendId] = state;
        } else {
            if (typeof state.included === 'undefined') {
                state.included = true;
            }
            if (!state.color) {
                state.color = friendColorPalette[index % friendColorPalette.length];
            }
            state.routes = state.routes || {};
            state.transport = state.transport || getTransportOption(friend && friend.mode).mode;
        }
        friend.mode = state.transport || friend.mode || getTransportOption().mode;
        return state;
    }

    function getFriendTransportMode(friend, index) {
        var state = ensureFriendState(friend, index);
        if (state && state.transport) {
            return state.transport;
        }
        return getTransportOption(friend && friend.mode).mode;
    }

    function getFriendCacheKey(transport, target) {
        if (!target) {
            return transport + '|0,0';
        }
        var lat = typeof target.lat === 'number' ? target.lat.toFixed(6) : '0';
        var lng = typeof target.lng === 'number' ? target.lng.toFixed(6) : '0';
        return transport + '|' + lat + ',' + lng;
    }

    function mergeOptions(base, extra) {
        var result = {};
        var key;
        if (base) {
            for (key in base) {
                if (Object.prototype.hasOwnProperty.call(base, key)) {
                    result[key] = base[key];
                }
            }
        }
        if (extra) {
            for (key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) {
                    result[key] = extra[key];
                }
            }
        }
        return result;
    }

    function getFriendDataById(friendId) {
        var normalized = friendId != null ? String(friendId) : '';
        if (!normalized) {
            return null;
        }
        for (var i = 0; i < friendsData.length; i += 1) {
            var candidate = friendsData[i];
            if (String(candidate.friend_id) === normalized) {
                return {friend: candidate, index: i};
            }
        }
        return null;
    }

    function updatePickupControlsVisibility(transportValue) {
        if (!pickupControls) {
            return;
        }
        var transportType = typeof transportValue === 'string' ? transportValue : (transportSelect ? transportSelect.value : 'driving');
        var isDriving = transportType === 'driving';
        if (isDriving) {
            pickupControls.classList.remove('hidden');
            if (pickupFriendSelect) {
                pickupFriendSelect.disabled = pickupFriendSelect.options.length <= 1;
            }
        } else {
            pickupControls.classList.add('hidden');
            if (pickupEnable) {
                pickupEnable.checked = false;
            }
            if (pickupFriendSelect) {
                pickupFriendSelect.value = '';
            }
            pickupFriendId = '';
        }
    }

    function updatePickupOptions() {
        if (!pickupFriendSelect) {
            pickupFriendId = '';
            return;
        }
        var previousValue = pickupFriendSelect.value || pickupFriendId || '';
        pickupFriendSelect.innerHTML = '';

        var placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = '— выберите друга —';
        pickupFriendSelect.appendChild(placeholderOption);

        var hasAvailableOption = false;
        for (var i = 0; i < friendsData.length; i += 1) {
            var friend = friendsData[i];
            var friendId = friend && friend.friend_id != null ? String(friend.friend_id) : '';
            if (!friendId) {
                continue;
            }
            var option = document.createElement('option');
            option.value = friendId;
            var label = friend.name || ('Друг #' + friendId);
            var lat = Number(friend.x_coord);
            var lng = Number(friend.y_coord);
            var hasCoords = !Number.isNaN(lat) && !Number.isNaN(lng);
            option.textContent = hasCoords ? label : label + ' (без координат)';
            option.disabled = !hasCoords;
            pickupFriendSelect.appendChild(option);
            if (hasCoords) {
                hasAvailableOption = true;
            }
        }

        var selectedValue = '';
        if (previousValue) {
            var existingOption = pickupFriendSelect.querySelector('option[value="' + previousValue + '"]');
            if (existingOption && !existingOption.disabled) {
                selectedValue = previousValue;
            }
        }
        if (!selectedValue && pickupFriendId) {
            var storedOption = pickupFriendSelect.querySelector('option[value="' + pickupFriendId + '"]');
            if (storedOption && !storedOption.disabled) {
                selectedValue = pickupFriendId;
            }
        }
        pickupFriendSelect.value = selectedValue;
        pickupFriendId = selectedValue;

        var noChoices = !hasAvailableOption;
        pickupFriendSelect.disabled = noChoices;
        if (noChoices) {
            pickupFriendSelect.value = '';
            pickupFriendId = '';
            if (pickupEnable) {
                pickupEnable.checked = false;
            }
        }
        updatePickupControlsVisibility();
    }

    function extractRouteDuration(route) {
        if (!route || !route.properties) {
            return null;
        }
        var summary = route.properties.summary;
        if (summary && typeof summary.duration_sec === 'number') {
            var num = Number(summary.duration_sec);
            return Number.isFinite(num) ? num : null;
        }
        if (route.features && route.features.length) {
            var firstSummary = route.features[0] && route.features[0].properties && route.features[0].properties.summary;
            if (firstSummary && typeof firstSummary.duration_sec === 'number') {
                var num2 = Number(firstSummary.duration_sec);
                return Number.isFinite(num2) ? num2 : null;
            }
        }
        return null;
    }

    function splitDriveAndWalk(route) {
        var result = {
            driveDurationSec: null,
            walkDurationSec: null,
            parkingPoint: null
        };
        if (!route || !route.features) {
            var total = extractRouteDuration(route);
            if (Number.isFinite(total)) {
                result.driveDurationSec = total;
            }
            return result;
        }
        var features = route.features;
        var drive = 0;
        var walk = 0;
        var parkingPoint = null;
        for (var i = 0; i < features.length; i += 1) {
            var feature = features[i];
            if (!feature || !feature.properties) {
                continue;
            }
            var props = feature.properties;
            var summary = props.summary || {};
            var duration = Number(summary.duration_sec);
            if (!Number.isFinite(duration) && typeof props.duration_sec === 'number') {
                duration = Number(props.duration_sec);
            }
            if (!Number.isFinite(duration)) {
                duration = 0;
            }
            var transportType = (props.transport || props.mode || props.segment_type || '').toLowerCase();
            if (transportType.indexOf('walk') !== -1 || transportType === 'pedestrian') {
                walk += duration;
                if (!parkingPoint) {
                    var geom = feature.geometry || {};
                    var coords = geom.coordinates;
                    if (Array.isArray(coords) && coords.length) {
                        var first = coords[0];
                        if (Array.isArray(first[0])) {
                            first = first[0];
                        }
                        if (Array.isArray(first) && first.length >= 2) {
                            parkingPoint = {lng: Number(first[0]), lat: Number(first[1])};
                        }
                    }
                }
            } else {
                drive += duration;
            }
        }
        if (walk > 0) {
            result.walkDurationSec = walk;
        }
        if (drive > 0) {
            result.driveDurationSec = drive;
        } else {
            var totalDuration = extractRouteDuration(route);
            if (Number.isFinite(totalDuration) && walk > 0) {
                result.driveDurationSec = Math.max(totalDuration - walk, 0);
            } else if (Number.isFinite(totalDuration)) {
                result.driveDurationSec = totalDuration;
            }
        }
        if (parkingPoint) {
            result.parkingPoint = parkingPoint;
        }
        return result;
    }

    function clearScheduleResults() {
        if (!scheduleResults) {
            return;
        }
        scheduleResults.innerHTML = '';
        scheduleResults.classList.add('hidden');
    }

    function resetRouteArtifacts() {
        clearLayers();
        if (routeSummaryEl) {
            routeSummaryEl.innerHTML = '';
        }
        if (routeStepsBody) {
            routeStepsBody.innerHTML = '';
        }
        if (routeInfoEl) {
            routeInfoEl.classList.add('hidden');
        }
        clearScheduleResults();
        scheduleData = null;
    }

    function renderScheduleMessage(message) {
        if (!scheduleResults) {
            return;
        }
        scheduleResults.innerHTML = '<div class="schedule-message">' + escapeHtml(message) + '</div>';
        scheduleResults.classList.remove('hidden');
    }

    function renderScheduleEntries(entries) {
        if (!scheduleResults) {
            return;
        }
        if (!entries || !entries.length) {
            renderScheduleMessage('Маршрут ещё не просчитан.');
            return;
        }
        entries.sort(function (a, b) {
            return a.time - b.time;
        });
        var fragments = entries.map(function (entry) {
            var title = escapeHtml(entry.title || 'Участник');
            var time = entry.time;
            var note = entry.note ? escapeHtml(entry.note) : '';
            var timeLabel = entry.timeLabel || formatScheduleTime(time);
            var html = '<div class="schedule-entry">';
            html += '<div class="schedule-entry__title">' + title + '</div>';
            html += '<div class="schedule-entry__time">' + escapeHtml(timeLabel) + '</div>';
            if (note) {
                html += '<div class="schedule-entry__note">' + note + '</div>';
            }
            html += '</div>';
            return html;
        }).join('');
        scheduleResults.innerHTML = fragments;
        scheduleResults.classList.remove('hidden');
    }

    function formatScheduleTime(timestamp) {
        if (!Number.isFinite(timestamp)) {
            return '—';
        }
        var date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '—';
        }
        var options = {hour: '2-digit', minute: '2-digit'};
        var timePart = date.toLocaleTimeString('ru-RU', options);
        var datePart = date.toLocaleDateString('ru-RU');
        return datePart + ' ' + timePart;
    }

    function renderDepartureNowSchedule() {
        if (!scheduleResults) {
            return;
        }
        if (!scheduleData || !scheduleData.ready) {
            renderScheduleMessage('Маршрут ещё не просчитан.');
            return;
        }
        var userSegments = scheduleData.userSegments || [];
        if (!userSegments.length) {
            renderScheduleMessage('Расписание недоступно — отсутствуют данные о маршруте.');
            return;
        }
        var nowMs = Date.now();
        var currentTime = nowMs;
        var pickupReadyMs = null;
        var zArrivalMs = null;
        var zDepartureMs = null;
        var walkStartMs = null;
        var hasWalkStage = false;
        var stopDurationSec = scheduleData.stopDurationSec || 180;
        var stopNote = stopDurationSec === 180 ? '3 минуты' : (Math.max(1, Math.round(stopDurationSec / 60)) + ' мин');
        var entries = [];
        entries.push({
            title: 'Вы',
            time: nowMs,
            note: 'Старт из точки А'
        });
        for (var j = 0; j < userSegments.length; j += 1) {
            var segment = userSegments[j];
            var segDuration = Number(segment.durationSec);
            if (!Number.isFinite(segDuration)) {
                renderScheduleMessage('Не удалось вычислить расписание: отсутствуют данные о времени пути.');
                return;
            }
            var segDurationMs = segDuration * 1000;
            if (segment.stage === 'stop') {
                if (!Number.isFinite(zArrivalMs)) {
                    zArrivalMs = currentTime;
                }
                entries.push({
                    title: 'Сбор и посадка',
                    time: currentTime,
                    note: stopNote
                });
            }
            if (segment.stage === 'walk') {
                hasWalkStage = true;
                walkStartMs = currentTime;
            }
            currentTime += segDurationMs;
            if (segment.stage === 'pickup') {
                pickupReadyMs = currentTime;
            } else if (segment.stage === 'Z') {
                zArrivalMs = currentTime;
            } else if (segment.stage === 'stop') {
                zDepartureMs = currentTime;
            }
        }
        if (!Number.isFinite(zArrivalMs)) {
            zArrivalMs = currentTime;
        }
        if (!Number.isFinite(zDepartureMs)) {
            zDepartureMs = zArrivalMs + stopDurationSec * 1000;
        }
        if (scheduleData.pickupInfo && scheduleData.pickupInfo.label && Number.isFinite(pickupReadyMs)) {
            entries.push({
                title: scheduleData.pickupInfo.label + ' (подбор)',
                time: pickupReadyMs,
                note: 'Время посадки'
            });
        }
        var friendSegments = scheduleData.friendSegments || [];
        for (var k = 0; k < friendSegments.length; k += 1) {
            var friendSeg = friendSegments[k];
            if (!Number.isFinite(friendSeg.durationSec)) {
                renderScheduleMessage('Не удалось вычислить расписание: нет данных о времени для ' + (friendSeg.name || 'друга') + '.');
                return;
            }
            var durationMs = friendSeg.durationSec * 1000;
            var friendStart = Number.isFinite(zArrivalMs) ? (zArrivalMs - durationMs) : nowMs;
            if (!Number.isFinite(friendStart)) {
                friendStart = nowMs;
            }
            entries.push({
                title: friendSeg.name || 'Друг',
                time: friendStart,
                note: 'Стартовать, чтобы успеть к точке встречи'
            });
        }
        var zMeetingNote = scheduleData.hasDestination === false ? 'Прибытие по вашему маршруту' : 'Все встречаются в точке встречи';
        entries.push({
            title: 'Сбор в точке встречи',
            time: zArrivalMs,
            note: zMeetingNote
        });
        if (hasWalkStage && Number.isFinite(walkStartMs)) {
            var walkNote = 'Оставить машину и идти пешком';
            if (scheduleData.parkingInfo && Number.isFinite(scheduleData.parkingInfo.walkDurationSec)) {
                var walkMinutes = Math.max(1, Math.round(scheduleData.parkingInfo.walkDurationSec / 60));
                walkNote += ' (~' + walkMinutes + ' мин)';
            }
            entries.push({
                title: 'Пешком от парковки',
                time: walkStartMs,
                note: walkNote
            });
        }
        if (scheduleData.hasDestination === false) {
            renderScheduleEntries(entries);
            return;
        }
        entries.push({
            title: 'Отправление из точки встречи',
            time: zDepartureMs,
            note: 'После сбора и посадки'
        });
        entries.push({
            title: 'Прибытие в точку Б',
            time: currentTime,
            note: 'Общее время прибытия'
        });
        renderScheduleEntries(entries);
    }

    function finalizeSchedule(options) {
        options = options || {};
        var preferDepartureNow = Boolean(options.departureNow);
        if (!scheduleResults) {
            return;
        }
        if (!scheduleData || !scheduleData.ready) {
            if (preferDepartureNow) {
                renderScheduleMessage('Маршрут ещё не просчитан.');
            } else if (arrivalTimeInput && arrivalTimeInput.value) {
                renderScheduleMessage('Постройте маршрут, чтобы увидеть расписание.');
            } else {
                clearScheduleResults();
            }
            return;
        }
        if (scheduleData.missingDuration) {
            renderScheduleMessage('Не удалось вычислить расписание: отсутствуют данные о времени пути.');
            return;
        }
        if (preferDepartureNow) {
            renderDepartureNowSchedule();
            return;
        }
        if (scheduleData.hasDestination === false) {
            renderScheduleMessage('Точка Б не задана — расписание рассчитывается только до точки встречи.');
            return;
        }
        if (!arrivalTimeInput || !arrivalTimeInput.value) {
            renderScheduleMessage('Укажите время прибытия в точку Б.');
            return;
        }
        var arrivalDate = new Date(arrivalTimeInput.value);
        if (Number.isNaN(arrivalDate.getTime())) {
            renderScheduleMessage('Некорректная дата/время.');
            return;
        }
        var arrivalMs = arrivalDate.getTime();
        var userSegments = scheduleData.userSegments || [];
        if (!userSegments.length) {
            renderScheduleMessage('Расписание недоступно — отсутствуют данные о маршруте.');
            return;
        }
        var totalDurationMs = 0;
        for (var i = 0; i < userSegments.length; i += 1) {
            var segDuration = Number(userSegments[i].durationSec);
            if (!Number.isFinite(segDuration)) {
                renderScheduleMessage('Нет данных о длительности маршрута.');
                return;
            }
            totalDurationMs += segDuration * 1000;
        }
        if (totalDurationMs > arrivalMs) {
            renderScheduleMessage('Время прибытия раньше времени старта.');
            return;
        }
        var userStartMs = arrivalMs - totalDurationMs;
        var currentTime = userStartMs;
        var pickupReadyMs = null;
        var zArrivalMs = null;
        var zDepartureMs = null;
        var walkStartMs = null;
        var hasWalkStage = false;
        var stopDurationSec = scheduleData.stopDurationSec || 180;
        var entries = [];
        entries.push({
            title: 'Вы',
            time: userStartMs,
            note: 'Старт из точки А'
        });
        for (var j = 0; j < userSegments.length; j += 1) {
            var segment = userSegments[j];
            var segDurationMs = Number(segment.durationSec || 0) * 1000;
            if (segment.stage === 'stop') {
                if (!Number.isFinite(zArrivalMs)) {
                    zArrivalMs = currentTime;
                }
                entries.push({
                    title: 'Сбор и посадка',
                    time: currentTime,
                    note: '3 минуты'
                });
            }
            if (segment.stage === 'walk') {
                hasWalkStage = true;
                walkStartMs = currentTime;
            }
            currentTime += segDurationMs;
            if (segment.stage === 'pickup') {
                pickupReadyMs = currentTime;
            } else if (segment.stage === 'Z') {
                zArrivalMs = currentTime;
            } else if (segment.stage === 'stop') {
                zDepartureMs = currentTime;
            }
        }
        if (!Number.isFinite(zArrivalMs)) {
            zArrivalMs = userStartMs;
        }
        if (!Number.isFinite(zDepartureMs)) {
            zDepartureMs = zArrivalMs + stopDurationSec * 1000;
        }
        if (scheduleData.pickupInfo && scheduleData.pickupInfo.label && Number.isFinite(pickupReadyMs)) {
            entries.push({
                title: scheduleData.pickupInfo.label + ' (подбор)',
                time: pickupReadyMs,
                note: 'Быть готовым к посадке'
            });
        }
        var friendSegments = scheduleData.friendSegments || [];
        for (var k = 0; k < friendSegments.length; k += 1) {
            var friendSeg = friendSegments[k];
            if (!Number.isFinite(friendSeg.durationSec)) {
                renderScheduleMessage('Не удалось вычислить расписание: нет данных о времени для ' + (friendSeg.name || 'друга') + '.');
                return;
            }
            var friendStartMs = zArrivalMs - friendSeg.durationSec * 1000;
            entries.push({
                title: friendSeg.name || 'Друг',
                time: friendStartMs,
                note: 'Стартовать, чтобы успеть к точке встречи'
            });
        }
        entries.push({
            title: 'Сбор в точке встречи',
            time: zArrivalMs,
            note: 'Все встречаются в точке встречи'
        });
        if (hasWalkStage && Number.isFinite(walkStartMs)) {
            var walkNote = 'Оставить машину и идти пешком';
            if (scheduleData.parkingInfo && Number.isFinite(scheduleData.parkingInfo.walkDurationSec)) {
                var walkMinutes = Math.max(1, Math.round(scheduleData.parkingInfo.walkDurationSec / 60));
                walkNote += ' (~' + walkMinutes + ' мин)';
            }
            entries.push({
                title: 'Пешком от парковки',
                time: walkStartMs,
                note: walkNote
            });
        }
        entries.push({
            title: 'Отправление из точки встречи',
            time: zDepartureMs,
            note: 'После сбора и посадки'
        });
        entries.push({
            title: 'Прибытие в точку Б',
            time: arrivalMs,
            note: 'Общее время прибытия'
        });
        renderScheduleEntries(entries);
    }

    function resetFriendRoutes() {
        Object.keys(friendStates).forEach(function (id) {
            var state = friendStates[id];
            if (state) {
                state.routes = {};
                if (state.routeToZ) {
                    state.routeToZ = null;
                }
            }
        });
    }

    function toggleFriendsPanel() {
        if (!friendsPanel || !friendsToggle) {
            return;
        }
        var isHidden = friendsPanel.classList.contains('hidden');
        if (isHidden) {
            friendsPanel.classList.remove('hidden');
            friendsToggle.classList.add('active');
            loadFriends().catch(function () {});
        } else {
            friendsPanel.classList.add('hidden');
            friendsToggle.classList.remove('active');
        }
    }

    function renderFriendsPlaceholder(text) {
        if (!friendsList) {
            return;
        }
        friendsList.innerHTML = '';
        var li = document.createElement('li');
        li.className = 'friends-panel__item friends-panel__item--placeholder';
        li.textContent = text;
        friendsList.appendChild(li);
        updatePickupOptions();
        if (pickupFriendSelect) {
            pickupFriendSelect.value = pickupFriendId || '';
        }
    }


function persistFriendTransport(friend, state, previousMode) {
    var friendId = friend && friend.friend_id;
    if (!friendId) {
        return;
    }
    var requestBody = {mode: state.transport || friend.mode};
    fetch('/api/friends/' + encodeURIComponent(String(friendId)), {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody)
    }).then(function (response) {
        if (!response.ok) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                var message = data && data.error ? String(data.error) : ('HTTP ' + response.status);
                throw new Error(message);
            });
        }
        return null;
    }).catch(function (error) {
        var fallbackMode = previousMode || 'public_transport';
        state.transport = fallbackMode;
        friend.mode = fallbackMode;
        var friendName = friend.name || ('Друг #' + friend.friend_id);
        var message = error && error.message ? error.message : String(error);
        log('Не удалось сохранить транспорт для ' + friendName + ': ' + message);
        renderFriendsList();
    });
}


    function renderFriendsList() {
        if (!friendsList) {
            return;
        }
        friendsList.innerHTML = '';
        if (!friendsData.length) {
            renderFriendsPlaceholder('Список друзей пуст');
            return;
        }
        friendsData.forEach(function (friend, index) {
            var state = ensureFriendState(friend, index);
            if (!state) {
                return;
            }
            var item = document.createElement('li');
            item.className = 'friends-panel__item';
            if (friend.friend_id === activeFriendId) {
                item.classList.add('friends-panel__item--active');
            }
            if (!state.included) {
                item.classList.add('friends-panel__item--inactive');
            }

            var left = document.createElement('div');
            left.className = 'friends-panel__item-left';

            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'friends-panel__checkbox';
            checkbox.checked = state.included !== false;
            checkbox.addEventListener('change', function (event) {
                var checked = Boolean(event.target.checked);
                state.included = checked;
                item.classList.toggle('friends-panel__item--inactive', !checked);
                var friendIdStr = String(friend.friend_id || '');
                if (!checked && pickupFriendId && pickupFriendId === friendIdStr) {
                    pickupFriendId = '';
                    if (pickupFriendSelect) {
                        pickupFriendSelect.value = '';
                    }
                    if (pickupEnable) {
                        pickupEnable.checked = false;
                    }
                }
                updatePickupOptions();
                scheduleMeetpointRecalculation();
            });

            var colorSwatch = document.createElement('span');
            colorSwatch.className = 'friends-panel__color';
            colorSwatch.style.backgroundColor = state.color;

            var nameSpan = document.createElement('span');
            nameSpan.className = 'friends-panel__item-name';
            nameSpan.textContent = friend.name || ('Друг #' + friend.friend_id);

            var metaSpan = document.createElement('span');
            metaSpan.className = 'friends-panel__item-meta';
            var transportOption = getTransportOption(state.transport || friend.mode);
            metaSpan.textContent = '(' + transportOption.label + ')';

            var transportBtn = document.createElement('button');
            transportBtn.type = 'button';
            transportBtn.className = 'friends-panel__transport-btn';
            transportBtn.textContent = transportOption.icon;
            transportBtn.title = transportOption.label;
            transportBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                var previousMode = state.transport || friend.mode;
                var next = getNextTransport(previousMode);
                state.transport = next.mode;
                friend.mode = next.mode;
                transportBtn.textContent = next.icon;
                transportBtn.title = next.label;
                metaSpan.textContent = '(' + next.label + ')';
                updatePickupOptions();
                renderFriendsList();
                persistFriendTransport(friend, state, previousMode);
                scheduleMeetpointRecalculation();
            });

            left.appendChild(checkbox);
            left.appendChild(colorSwatch);
            left.appendChild(nameSpan);
            left.appendChild(transportBtn);
            left.appendChild(metaSpan);
            left.addEventListener('click', function (event) {
                if (event.target === checkbox || event.target === transportBtn) {
                    return;
                }
                selectFriend(friend);
            });

            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Показать';
            button.addEventListener('click', function () {
                selectFriend(friend);
            });

            item.appendChild(left);
            item.appendChild(button);
        friendsList.appendChild(item);
        });
        updatePickupOptions();
        if (pickupFriendSelect) {
            pickupFriendSelect.value = pickupFriendId || '';
        }
        if (pickupEnable && pickupFriendSelect && !pickupFriendSelect.value) {
            pickupEnable.checked = false;
        }
        scheduleMeetpointRecalculation();
        refreshFriendMarkers();
    }

    function loadFriends(forceReload) {
        var requireReload = Boolean(forceReload);
        if (friendsLoaded && !requireReload) {
            renderFriendsList();
            updatePickupControlsVisibility();
            return Promise.resolve(friendsData);
        }
        if (friendsLoading && friendsLoadPromise) {
            return friendsLoadPromise;
        }

        friendsLoading = true;
        if (friendsList) {
            renderFriendsPlaceholder('Загружаем...');
        }

        var request = fetch('/api/friends')
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            })
            .then(function (data) {
                friendsData = Array.isArray(data.friends) ? data.friends : [];
                var friendIdSet = {};
                friendsData.forEach(function (friend, index) {
                    var state = ensureFriendState(friend, index);
                    friendIdSet[String(friend.friend_id || '')] = true;
                    if (state && typeof state.included === 'undefined') {
                        state.included = true;
                    }
                });
                Object.keys(friendStates).forEach(function (id) {
                    if (!friendIdSet[id]) {
                        delete friendStates[id];
                    }
                });

                if (data.target_z && typeof data.target_z.lat !== 'undefined' && typeof data.target_z.lng !== 'undefined') {
                    var lat = Number(data.target_z.lat);
                    var lng = Number(data.target_z.lng);
                    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                        targetZPoint = {lat: lat, lng: lng};
                        var targetKey = getFriendCacheKey('target', targetZPoint);
                        if (lastKnownTargetZKey !== targetKey) {
                            lastKnownTargetZKey = targetKey;
                            resetFriendRoutes();
                        }
                    }
                }

                friendsLoaded = true;
                renderFriendsList();
                updatePickupControlsVisibility();
                log('Загружено друзей: ' + friendsData.length);
                scheduleMeetpointRecalculation();
                return friendsData;
            })
            .catch(function (error) {
                friendsLoaded = false;
                renderFriendsPlaceholder('Не удалось загрузить друзей');
                updatePickupControlsVisibility();
                log('Ошибка загрузки друзей: ' + (error && error.message ? error.message : String(error)));
                throw error;
            })
            .finally(function () {
                friendsLoading = false;
                friendsLoadPromise = null;
            });

        friendsLoadPromise = request;
        return request;
    }


    function resolveTargetZ() {
        var chosenPoint = null;
        var source = 'config';
        var dynamicPoint = null;
        var overridePoint = meetpointState && meetpointState.point;
        var overrideMeta = (meetpointState && meetpointState.meta) || null;
        if (overridePoint && typeof overridePoint.lat === 'number' && typeof overridePoint.lng === 'number') {
            var overrideLat = Number(overridePoint.lat);
            var overrideLng = Number(overridePoint.lng);
            if (!Number.isNaN(overrideLat) && !Number.isNaN(overrideLng)) {
                chosenPoint = {lat: overrideLat, lng: overrideLng};
                source = (overrideMeta && overrideMeta.source) || 'meetpoint';
            }
        }
        if (!chosenPoint) {
            dynamicPoint = calculateDynamicTargetZ();
        }
        if (!chosenPoint && dynamicPoint) {
            chosenPoint = dynamicPoint;
            source = 'dynamic';
        } else if (!chosenPoint && config && config.targetZ && typeof config.targetZ.lat === 'number' && typeof config.targetZ.lng === 'number') {
            var lat = Number(config.targetZ.lat);
            var lng = Number(config.targetZ.lng);
            if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                chosenPoint = {lat: lat, lng: lng};
            }
        } else if (!chosenPoint && targetZPoint) {
            chosenPoint = targetZPoint;
            source = 'cached';
        }
        if (chosenPoint) {
            var newKey = getFriendCacheKey('target', chosenPoint);
            if (lastKnownTargetZKey !== newKey) {
                lastKnownTargetZKey = newKey;
                resetFriendRoutes();
            }
        } else {
            lastKnownTargetZKey = null;
        }
        targetZPoint = chosenPoint;
        if (scheduleData) {
            scheduleData.targetSource = source;
            scheduleData.dynamicPoint = dynamicPoint || null;
            var methodLabel = null;
            if (overrideMeta && chosenPoint) {
                if (overrideMeta.method) {
                    methodLabel = overrideMeta.method;
                } else if (overrideMeta.type_of_meetpoint) {
                    methodLabel = overrideMeta.type_of_meetpoint;
                } else if (overrideMeta.source) {
                    methodLabel = overrideMeta.source;
                }
            }
            if (methodLabel) {
                scheduleData.meetpointMethod = methodLabel;
            } else {
                delete scheduleData.meetpointMethod;
            }
        }
        updateMeetpointMarker(chosenPoint, overrideMeta || (chosenPoint ? {source: source} : null));
        return targetZPoint;
    }

    function collectUserRouteOptions(transport) {
        var options = {transport: transport};
        if (transport === 'public_transport') {
            var modes = [];
            if (ptOptionCheckboxes && ptOptionCheckboxes.forEach) {
                ptOptionCheckboxes.forEach(function (checkbox) {
                    if (checkbox.checked) {
                        modes.push(checkbox.value);
                    }
                });
            }
            if (!modes.length) {
                modes = ['bus', 'tram', 'trolleybus', 'metro', 'shuttle_bus'];
            }
            options.publicTransportModes = modes;
        } else {
            var allowed = FILTER_MATRIX[transport] || [];
            var filters = Array.prototype.filter.call(filtersControls, function (checkbox) {
                return !checkbox.disabled && checkbox.checked && allowed.indexOf(checkbox.value) !== -1;
            }).map(function (checkbox) {
                return checkbox.value;
            });
            options.filters = filters;
            options.routeMode = routeModeSelect ? routeModeSelect.value : 'fastest';
            var trafficModeValue = trafficModeSelect ? trafficModeSelect.value : 'jam';
            options.trafficMode = trafficModeValue;
            options.output = outputSelect ? outputSelect.value : 'detailed';
            options.needAltitudes = Boolean(needAltitudesToggle && !needAltitudesToggle.disabled && needAltitudesToggle.checked);
            options.allowLockedRoads = Boolean(allowLockedToggle && allowLockedToggle.checked);
            var alternativeValue = alternativeInput ? parseInt(alternativeInput.value, 10) : 0;
            if (!Number.isNaN(alternativeValue) && alternativeValue > 0) {
                options.alternative = alternativeValue;
            }
        }
        return options;
    }

    function buildFriendRouteOptions(friend) {
        var transport = mapFriendTransport(friend.mode);
        var options = {transport: transport};
        if (transport === 'public_transport') {
            options.publicTransportModes = ['bus', 'tram', 'trolleybus', 'metro', 'shuttle_bus'];
        } else {
            options.routeMode = 'fastest';
            options.trafficMode = 'jam';
            options.output = 'detailed';
            options.filters = [];
        }
        return options;
    }

    function createRouteBody(start, destination, options) {
        var startLat = Number(start.lat);
        var startLng = Number(start.lng);
        var destLat = Number(destination.lat);
        var destLng = Number(destination.lng);
        var body = {
            start: {lat: startLat, lng: startLng},
            destination: {lat: destLat, lng: destLng},
            transport: options.transport || 'driving'
        };
        if (options.startName) {
            body.start_name = options.startName;
        }
        if (options.destinationName) {
            body.destination_name = options.destinationName;
        }
        if (body.transport === 'public_transport') {
            if (Array.isArray(options.publicTransportModes) && options.publicTransportModes.length) {
                body.public_transport_modes = options.publicTransportModes;
            }
        } else {
            if (options.routeMode) {
                body.route_mode = options.routeMode;
            }
            if (options.output) {
                body.output = options.output;
            }
            if (options.trafficMode) {
                body.traffic_mode = options.trafficMode;
            }
            if (Array.isArray(options.filters) && options.filters.length) {
                body.filters = options.filters;
            }
            if (options.needAltitudes) {
                body.need_altitudes = true;
            }
            if (options.allowLockedRoads) {
                body.allow_locked_roads = true;
            }
            if (typeof options.alternative === 'number' && options.alternative > 0) {
                body.alternative = options.alternative;
            }
        }
        return body;
    }

    function requestRoute(body, label) {
        return fetch('/api/quick_route', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        })
            .then(function (response) {
                return response.text().then(function (rawText) {
                    var data = rawText ? JSON.parse(rawText) : null;
                    if (!response.ok || !data) {
                        log('Ошибка маршрута (' + label + '): ' + (rawText || ('HTTP ' + response.status)));
                        return null;
                    }
                    var summary = data.properties && data.properties.summary;
                    if (summary) {
                        var transport = summary.transport || body.transport || '—';
                        var distance = formatDistance(summary.distance_m);
                        var duration = formatDuration(summary.duration_sec);
                        var message = label + ' [' + transport + ']: ' + distance;
                        if (duration) {
                            message += ', ' + duration;
                        }
                        if (summary.error) {
                            message += '. ' + summary.error;
                        }
                        log(message);
                    }
                    return data;
                });
            })
            .catch(function (error) {
                log('Ошибка запроса маршрута (' + label + '): ' + error);
                return null;
            });
    }

    function selectFriend(friend) {
        if (!friend) {
            return;
        }
        activeFriendId = friend.friend_id;
        ensureFriendState(friend, 0);
        var lat = Number(friend.x_coord);
        var lng = Number(friend.y_coord);
        if (Number.isNaN(lat) || Number.isNaN(lng)) {
            log('У друга ' + (friend.name || friend.friend_id || 'без имени') + ' отсутствуют валидные координаты');
            renderFriendsList();
            return;
        }
        var point = {
            name: friend.name || ('Друг #' + friend.friend_id),
            address: friend.mode ? ('Транспорт: ' + friend.mode) : null,
            point: {lat: lat, lng: lng}
        };
        lastInspectedPoint = point;
        showPointInfo(point);
        highlightInspection(point);
        showPointPopup(point);
        if (map) {
            map.setView([lat, lng], Math.max(map.getZoom(), 13));
        }
        renderFriendsList();
    }

    function waitForDG(attempt) {
        attempt = attempt || 0;
        if (window.DG && typeof window.DG.then === 'function') {
            initMap();
            return;
        }
        if (attempt === 0) {
            log('Ждём загрузку 2GIS MapGL JS API...');
        }
        if (attempt > 20) {
            log('2GIS MapGL JS API не загрузился — проверьте подключение скрипта и API-ключ.');
            return;
        }
        setTimeout(function () { waitForDG(attempt + 1); }, 250);
    }

    function initMap() {
        DG.then(function () {
            var mapOptions = {
                center: [55.751244, 37.618423],
                zoom: 12
            };
            if (apiKey) {
                mapOptions.key = apiKey;
            } else {
                log('Переменная 2GIS_API_KEY не задана — MapGL карта может не загрузиться');
            }
            map = DG.map('map', mapOptions);
            log('Карта инициализирована');

            map.zoomControl.setPosition('topright');
            map.on('click', function (event) {
                if (selectingStart) {
                    setStartPoint(event.latlng, lastInspectedPoint && lastInspectedPoint.name);
                    selectingStart = false;
                    if (selectStartButton) {
                        selectStartButton.classList.remove('active');
                    }
                } else {
                    inspectPoint(event.latlng);
                }
            });

            if (enableRaster && apiKey) {
                attachRasterLayer(apiKey);
            }
        }, function () {
            log('Не удалось инициализировать карту через DG.then');
        });
    }

    function attachRasterLayer(key) {
        if (!DG || typeof DG.rasterLayer !== 'function') {
            log('DG.rasterLayer ?????????? ? ?????????? ??????????? ?????????? ????.');
            return;
        }
        var rasterTemplate = 'https://tile{s}.maps.2gis.com/tiles?layer=map&v=7.0.0&x={x}&y={y}&z={z}&key=' + key;
        var rasterLayer = DG.rasterLayer(rasterTemplate, {
            maxZoom: 18,
            minZoom: 2,
            subdomains: ['0', '1', '2', '3']
        });
        rasterLayer.on('tileerror', function () {
            log('Raster слой 2GIS недоступен — используется стандартная подложка.');
            if (map && map.hasLayer(rasterLayer)) {
                map.removeLayer(rasterLayer);
            }
        });
        rasterLayer.addTo(map);
    }

    async function updateTransportUi() {
        if (!friendsLoaded) {
            try {
                await loadFriends();
            } catch (error) {
                log('Не удалось загрузить список друзей перед обновлением интерфейса транспорта: ' + (error && error.message ? error.message : String(error)));
            }
        }
        var transport = transportSelect ? transportSelect.value : 'driving';
        var allowed = FILTER_MATRIX[transport] || [];

        filtersControls.forEach(function (checkbox) {
            var supported = allowed.indexOf(checkbox.value) !== -1;
            checkbox.disabled = !supported;
            if (!supported) {
                checkbox.checked = false;
            }
        });

        if (transport === 'walking' || transport === 'bicycle' || transport === 'scooter' || transport === 'truck') {
            needAltitudesToggle.disabled = false;
        } else {
            needAltitudesToggle.checked = false;
            needAltitudesToggle.disabled = true;
        }

        var isPublic = transport === 'public_transport';
        if (ptOptionsBlock) {
            ptOptionsBlock.classList.toggle('hidden', !isPublic);
        }
        if (optionsBlock) {
            optionsBlock.classList.toggle('hidden', isPublic);
        }
        if (trafficRow) {
            trafficRow.classList.toggle('hidden', isPublic);
        }
        if (alternativeRow) {
            alternativeRow.classList.toggle('hidden', isPublic);
        }
        updatePickupControlsVisibility(transport);
    }

    function clearLayers() {
        layers.forEach(function (layer) {
            if (map && layer && map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        });
        layers = [];
    }

    function drawGeoJSON(featureCollection, graph, options) {
        options = options || {};
        if (!featureCollection || featureCollection.type !== 'FeatureCollection') {
            log('GeoJSON отсутствует или неверного типа');
            return;
        }
        var shouldClear = options.clear !== false;
        if (shouldClear) {
            clearLayers();
        }
        var palette = ['#1976d2', '#ff7043', '#66bb6a', '#ab47bc', '#ffa726'];
        var colorIndex = 0;
        var defaultWeight = typeof options.weight === 'number' ? options.weight : 5;
        var defaultOpacity = typeof options.opacity === 'number' ? options.opacity : 0.9;
        var dashArray = options.dashArray || null;

        featureCollection.features.forEach(function (feature) {
            if (!feature || !feature.geometry) {
                return;
            }
            var geometry = feature.geometry;
            var color = options.color || palette[colorIndex % palette.length];
            colorIndex += 1;

            if (!options.color && feature.properties && feature.properties.transport) {
                var baseColor = feature.properties.transport === 'public_transport' ? '#8e24aa' : '#1976d2';
                color = feature.properties.is_alternative ? '#43a047' : baseColor;
            } else if (!options.color && feature.properties && feature.properties.user_id) {
                color = palette[(feature.properties.user_id.length + colorIndex) % palette.length];
            }

            if (geometry.type === 'LineString') {
                var latlngs = geometry.coordinates.map(function (coord) {
                    return [coord[1], coord[0]];
                });
                var shapeOptions = {
                    color: color,
                    weight: defaultWeight,
                    opacity: defaultOpacity
                };
                if (dashArray) {
                    shapeOptions.dashArray = dashArray;
                }
                if (options.lineJoin) {
                    shapeOptions.lineJoin = options.lineJoin;
                }
                var polyline = DG.polyline(latlngs, shapeOptions);
                polyline.addTo(map);
                layers.push(polyline);
            } else if (geometry.type === 'MultiPoint') {
                var markers = geometry.coordinates.map(function (coord) {
                    return DG.marker([coord[1], coord[0]]);
                });
                markers.forEach(function (marker) {
                    marker.addTo(map);
                    layers.push(marker);
                });
            }
        });

        var graphToRender = options.graph === false ? null : graph;
        if (graphToRender && graphToRender.nodes) {
            graphToRender.nodes.forEach(function (node) {
                if (typeof node.lat !== 'number' || typeof node.lng !== 'number') {
                    return;
                }
                var marker = DG.circleMarker([node.lat, node.lng], {
                    radius: 4,
                    color: node.type === 'start' ? '#2e7d32' : node.type === 'end' ? '#d32f2f' : '#0288d1',
                    weight: 2,
                    opacity: 0.9,
                    fillOpacity: 0.8
                }).bindPopup(renderNodePopup(node));
                marker.addTo(map);
                layers.push(marker);
            });
        }
    }


    function renderNodePopup(node) {
        var lines = [];
        if (node.label) {
            lines.push('<strong>' + escapeHtml(node.label) + '</strong>');
        }
        lines.push('Координаты: ' + node.lat.toFixed(6) + ', ' + node.lng.toFixed(6));
        if (node.distance_m != null) {
            lines.push('Отрезок: ' + formatDistance(node.distance_m));
        }
        if (node.duration_sec != null) {
            lines.push('Время: ' + formatDuration(node.duration_sec));
        }
        if (node.instruction) {
            lines.push('Действие: ' + escapeHtml(node.instruction));
        }
        return lines.join('<br>');
    }

    function renderRouteDetails(featureCollection, options) {
        options = options || {};
        var append = Boolean(options.append);
        var hideSteps = Boolean(options.hideSteps);

        if (!append) {
            routeSummaryEl.innerHTML = '';
            routeStepsBody.innerHTML = '';
        }

        if (!featureCollection || !featureCollection.properties) {
            if (!append) {
                routeInfoEl.classList.add('hidden');
            }
            return;
        }

        var summary = featureCollection.properties.summary || {};
        var graph = featureCollection.properties.graph || {};
        var details = featureCollection.properties.details || {};

        var section = document.createElement('div');
        section.className = 'route-summary__section';
        if (options.title) {
            var titleEl = document.createElement('div');
            titleEl.className = 'route-summary__title';
            titleEl.textContent = options.title;
            section.appendChild(titleEl);
        }
        var summaryGrid = document.createElement('div');
        summaryGrid.className = 'route-summary__grid';

        function addSummary(label, value) {
            var span = document.createElement('span');
            span.textContent = label + ': ' + value;
            summaryGrid.appendChild(span);
        }

        addSummary('Транспорт', summary.transport || details.transport || '—');
        addSummary('Дистанция', formatDistance(summary.distance_m));
        addSummary('Время', formatDuration(summary.duration_sec));
        if (summary.altitude_gain != null || summary.altitude_loss != null) {
            addSummary('Перепад высот', '+' + formatAltitude(summary.altitude_gain) + ' / -' + formatAltitude(summary.altitude_loss));
        }
        if (summary.transfer_count != null) {
            addSummary('Пересадки', summary.transfer_count);
        }
        if (summary.crossing_count != null) {
            addSummary('Переходы', summary.crossing_count);
        }
        if (summary.total_walkway_distance) {
            addSummary('Пешком', summary.total_walkway_distance);
        }
        if (summary.modes && summary.modes.length) {
            addSummary('Виды транспорта', summary.modes.join(', '));
        }
        if (details.route_mode) {
            addSummary('Маршрут', details.route_mode);
        }
        if (details.traffic_mode) {
            addSummary('Пробки', details.traffic_mode);
        }
        if (details.filters && details.filters.length) {
            addSummary('Фильтры', details.filters.join(', '));
        }
        if (details.has_alternatives) {
            addSummary('Альтернативы', 'есть');
        }

        section.appendChild(summaryGrid);
        routeSummaryEl.appendChild(section);

        if (!hideSteps && graph.edges && graph.edges.length) {
            if (append && routeStepsBody.children.length) {
                var separator = document.createElement('tr');
                var td = document.createElement('td');
                td.colSpan = 4;
                td.className = 'route-steps__separator';
                separator.appendChild(td);
                routeStepsBody.appendChild(separator);
            }
            graph.edges.forEach(function (edge) {
                var tr = document.createElement('tr');
                var numberTd = document.createElement('td');
                numberTd.textContent = String(routeStepsBody.children.length + 1);
                var instructionTd = document.createElement('td');
                instructionTd.textContent = edge.instruction || edge.label || 'Следуйте дальше';
                var distTd = document.createElement('td');
                distTd.textContent = formatDistance(edge.distance_m);
                var timeTd = document.createElement('td');
                timeTd.textContent = formatDuration(edge.duration_sec);
                tr.appendChild(numberTd);
                tr.appendChild(instructionTd);
                tr.appendChild(distTd);
                tr.appendChild(timeTd);
                routeStepsBody.appendChild(tr);
            });
        }

        routeInfoEl.classList.remove('hidden');
    }

    function formatDistance(distance) {
        if (distance == null) {
            return '—';
        }
        if (distance >= 1000) {
            return (distance / 1000).toFixed(2) + ' км';
        }
        return Math.round(distance) + ' м';
    }

    function formatDuration(duration) {
        if (duration == null) {
            return '—';
        }
        var minutes = Math.floor(duration / 60);
        var seconds = Math.round(duration % 60);
        if (minutes > 0) {
            return minutes + ' мин ' + (seconds > 0 ? seconds + ' с' : '');
        }
        return seconds + ' с';
    }

    function formatAltitude(value) {
        if (value == null) {
            return '—';
        }
        return Math.round(value) + ' м';
    }

    function escapeHtml(text) {
        if (text == null) {
            return '';
        }
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fetchSample() {
        fetch('/api/sample_input')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                scriptInput.value = JSON.stringify(data, null, 2);
                log('Пример загружен');
            })
            .catch(function (err) {
                log('Ошибка загрузки примера: ' + err);
            });
    }

    function uploadScript() {
        var payload;
        try {
            payload = JSON.parse(scriptInput.value);
        } catch (err) {
            log('Некорректный JSON: ' + err.message);
            return;
        }
        fetch('/api/upload_script', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        })
            .then(function (res) { return res.json().then(function (data) { return {status: res.status, body: data}; }); })
            .then(function (res) {
                if (res.status >= 400) {
                    log('Ошибка сохранения: ' + JSON.stringify(res.body));
                    return;
                }
                payload.script_id = res.body.script_id;
                scriptInput.value = JSON.stringify(payload, null, 2);
                log('Скрипт сохранён: ' + res.body.script_id);
            })
            .catch(function (err) {
                log('Ошибка запроса upload: ' + err);
            });
    }

    function optimize() {
        var payload;
        try {
            payload = JSON.parse(scriptInput.value);
        } catch (err) {
            log('Некорректный JSON: ' + err.message);
            return;
        }
        if (!payload.script_id) {
            log('script_id отсутствует — сохраните скрипт перед оптимизацией');
            return;
        }
        var requestBody = {
            script_id: payload.script_id,
            algorithm: algorithmSelect.value
        };
        fetch('/api/optimize', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(requestBody)
        })
            .then(function (res) { return res.json().then(function (data) { return {status: res.status, body: data}; }); })
            .then(function (res) {
                if (res.status >= 400) {
                    log('Ошибка запуска оптимизации: ' + JSON.stringify(res.body));
                    return;
                }
                log('Оптимизация запущена: ' + res.body.task_id);
                pollTask(res.body.task_id, payload.script_id);
            })
            .catch(function (err) {
                log('Ошибка запроса optimize: ' + err);
            });
    }

    function pollTask(taskId, scriptId) {
        var attempts = 0;
        function check() {
            attempts += 1;
            fetch('/api/status/' + taskId)
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    log('Статус ' + taskId + ': ' + data.status);
                    if (data.status === 'done') {
                        fetchRoute(scriptId);
                    } else if (data.status === 'error') {
                        log('Ошибка задачи: ' + data.error);
                    } else if (attempts < 10) {
                        setTimeout(check, 1000);
                    }
                })
                .catch(function (err) {
                    log('Ошибка проверки статуса: ' + err);
                });
        }
        check();
    }

    function fetchRoute(scriptId) {
        fetch('/api/route/' + scriptId)
            .then(function (res) { return res.json(); })
            .then(function (geojson) {
                drawGeoJSON(geojson);
                renderRouteDetails(null);
                log('Маршруты отображены');
            })
            .catch(function (err) {
                log('Ошибка получения маршрута: ' + err);
            });
    }

    function searchPlaces() {
        var query = searchInput.value.trim();
        if (!query) {
            log('Введите запрос для поиска');
            return;
        }
        fetch('/api/places?q=' + encodeURIComponent(query))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var results = data.results || [];
                renderResults(results);
                if (results.length === 0) {
                    log('Ничего не найдено по запросу: ' + query);
                } else {
                    log('Найдено результатов: ' + results.length);
                }
            })
            .catch(function (err) {
                log('Ошибка поиска места: ' + err);
            });
    }

    function renderResults(results) {
        resultsList.innerHTML = '';
        results.forEach(function (item, index) {
            var li = document.createElement('li');
            li.textContent = item.name + (item.address ? ' — ' + item.address : '');
            li.dataset.lat = item.point && item.point.lat;
            li.dataset.lng = item.point && item.point.lng;
            li.addEventListener('click', function () {
                selectDestination(item, li);
            });
            resultsList.appendChild(li);
            if (index === 0) {
                selectDestination(item, li);
            }
        });
    }

    function selectDestination(place, listItem) {
        Array.prototype.forEach.call(resultsList.children, function (el) {
            el.classList.remove('active');
        });
        if (listItem) {
            listItem.classList.add('active');
        }
        applyDestination(place);
        showPointInfo(place);
        lastInspectedPoint = place;
    }

    function applyDestination(place) {
        selectedDestination = place;
        destinationLabel = place.name || 'Точка назначения';
        if (destinationMarker && map && map.hasLayer(destinationMarker)) {
            map.removeLayer(destinationMarker);
        }
        if (place && place.point) {
            destinationMarker = DG.marker([place.point.lat, place.point.lng], {title: destinationLabel});
            destinationMarker.addTo(map);
            map.setView([place.point.lat, place.point.lng], 14);
            log('Точка Б установлена: ' + destinationLabel);
        }
        scheduleMeetpointRecalculation();
    }

    function setStartPoint(latlng, label) {
        startPoint = {lat: latlng.lat, lng: latlng.lng};
        startLabel = label || 'Точка А';
        if (startMarker && map && map.hasLayer(startMarker)) {
            map.removeLayer(startMarker);
        }
        startMarker = DG.marker([latlng.lat, latlng.lng], {title: startLabel});
        startMarker.addTo(map);
        log('Точка А установлена: ' + latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5));
        showPointInfo({
            name: startLabel,
            address: null,
            point: {lat: latlng.lat, lng: latlng.lng}
        });
        scheduleMeetpointRecalculation();
    }

    function clearStartPoint() {
        var hadPoint = Boolean(startMarker || startPoint);
        if (startMarker && map && map.hasLayer(startMarker)) {
            map.removeLayer(startMarker);
        }
        startMarker = null;
        startPoint = null;
        startLabel = 'Точка А';
        selectingStart = false;
        hidePointInfo();
        resetRouteArtifacts();
        if (hadPoint) {
            log('Точка А сброшена.');
        } else {
            log('Точка А ещё не задана.');
        }
        scheduleMeetpointRecalculation();
    }

    function showPointInfo(point) {
        if (!point) {
            hidePointInfo();
            return;
        }
        pointInfoName.textContent = point.name || 'Точка на карте';
        if (point.address) {
            pointInfoAddress.textContent = point.address;
            pointInfoAddress.classList.remove('muted');
        } else {
            pointInfoAddress.textContent = 'Адрес не найден';
            pointInfoAddress.classList.add('muted');
        }
        pointInfoAddress.classList.remove('hidden');
        pointInfoCoords.textContent = point.point.lat.toFixed(6) + ', ' + point.point.lng.toFixed(6);
        pointInfoEl.classList.remove('hidden');
    }

    function hidePointInfo() {
        pointInfoEl.classList.add('hidden');
    }

    var inspectionPopup = null;

    function showPointPopup(point) {
        if (!map || !point || !point.point) {
            return;
        }
        if (inspectionPopup) {
            map.closePopup(inspectionPopup);
            inspectionPopup = null;
        }
        var container = document.createElement('div');
        container.className = 'map-popup';
        var title = document.createElement('div');
        title.className = 'map-popup__title';
        title.textContent = point.name || 'Точка на карте';
        container.appendChild(title);
        var coord = document.createElement('div');
        coord.className = 'map-popup__coords';
        coord.textContent = point.point.lat.toFixed(6) + ', ' + point.point.lng.toFixed(6);
        container.appendChild(coord);
        var buttons = document.createElement('div');
        buttons.className = 'map-popup__actions';
        var startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.textContent = 'Сделать стартом';
        startBtn.addEventListener('click', function () {
            setStartPoint(point.point, point.name);
            if (inspectionPopup) {
                map.closePopup(inspectionPopup);
                inspectionPopup = null;
            }
        });
        var destBtn = document.createElement('button');
        destBtn.type = 'button';
        destBtn.textContent = 'Сделать финишем';
        destBtn.addEventListener('click', function () {
            applyDestination(point);
            if (inspectionPopup) {
                map.closePopup(inspectionPopup);
                inspectionPopup = null;
            }
        });
        buttons.appendChild(startBtn);
        buttons.appendChild(destBtn);
        container.appendChild(buttons);
        inspectionPopup = DG.popup({closeButton: true}).setLatLng([point.point.lat, point.point.lng]).setContent(container);
        inspectionPopup.addTo(map);
    }

    function inspectPoint(latlng) {
        fetch('/api/point_info?lat=' + latlng.lat + '&lng=' + latlng.lng)
            .then(function (res) { return res.json(); })
            .then(function (info) {
                var point = {
                    name: info.name || 'Точка на карте',
                    address: info.address,
                    point: {
                        lat: (info.point && info.point.lat) || latlng.lat,
                        lng: (info.point && info.point.lng) || latlng.lng
                    },
                    source: info.source || 'unknown'
                };
                lastInspectedPoint = point;
                showPointInfo(point);
                highlightInspection(point);
                showPointPopup(point);
                log('Выбрана точка: ' + point.name);
            })
            .catch(function (err) {
                log('Не удалось получить информацию о точке: ' + err);
                var fallback = {
                    name: 'Точка на карте',
                    address: null,
                    point: {lat: latlng.lat, lng: latlng.lng}
                };
                lastInspectedPoint = fallback;
                showPointInfo(fallback);
                highlightInspection(fallback);
                showPointPopup(fallback);
            });
    }

    function highlightInspection(point) {
        if (!map) {
            return;
        }
        if (inspectionMarker && map.hasLayer(inspectionMarker)) {
            map.removeLayer(inspectionMarker);
        }
        inspectionMarker = DG.marker([point.point.lat, point.point.lng], {
            title: point.name || 'Выбранная точка',
            icon: DG.icon({
                iconUrl: 'https://maps.api.2gis.ru/2.0/img/pin_mark.png',
                iconSize: [20, 28]
            })
        });
        inspectionMarker.addTo(map);
    }

    function useGeolocation() {
        if (!navigator.geolocation) {
            log('Геолокация не поддерживается в этом браузере');
            return;
        }
        navigator.geolocation.getCurrentPosition(function (position) {
            var lat = position.coords.latitude;
            var lng = position.coords.longitude;
            setStartPoint({lat: lat, lng: lng}, 'Моё местоположение');
            if (map) {
                map.setView([lat, lng], Math.max(map.getZoom(), 13));
            }
        }, function (error) {
            log('Не удалось получить геолокацию: ' + error.message);
        }, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 30000
        });
    }

    async function openRoute() {
        var hasDestination = Boolean(selectedDestination && selectedDestination.point);
        if (!hasDestination) {
            log('Точка Б не задана — строим маршруты только до точки встречи');
        }
        if (!startPoint) {
            log('Укажите точку старта на карте или через геолокацию');
            return;
        }
        var transport = transportSelect ? transportSelect.value : 'driving';
        var userOptions = collectUserRouteOptions(transport);
        try {
            await requestMeetpointUpdate(true);
        } catch (error) {
            log('Не удалось обновить точку встречи: ' + (error && error.message ? error.message : String(error)));
        }
        var target = resolveTargetZ();
        if (!target) {
            log('Точка встречи не настроена. Заполните TARGET_Z_LAT и TARGET_Z_LNG.');
            return;
        }

        var friendsPanelWasVisible = Boolean(friendsPanel && !friendsPanel.classList.contains('hidden'));
        function restoreFriendsPanel() {
            if (friendsPanelWasVisible && friendsPanel && friendsToggle) {
                friendsPanel.classList.remove('hidden');
                friendsToggle.classList.add('active');
                loadFriends().catch(function () {});
            }
        }

        clearLayers();
        routeSummaryEl.innerHTML = '';
        routeStepsBody.innerHTML = '';
        routeInfoEl.classList.add('hidden');
        clearScheduleResults();

        scheduleData = {
            userSegments: [],
            friendSegments: [],
            pickupInfo: null,
            parkingInfo: null,
            ready: false,
            missingDuration: false,
            stopDurationSec: 180,
            hasDestination: hasDestination
        };

        var pickupActive = pickupEnable && pickupEnable.checked;
        var pickupEntry = null;
        var pickupPoint = null;
        var pickupLabel = '';

        function resetPickupSelection() {
            pickupFriendId = '';
            if (pickupEnable) {
                pickupEnable.checked = false;
            }
            if (pickupFriendSelect) {
                pickupFriendSelect.value = '';
            }
            updatePickupOptions();
        }

        if (pickupActive) {
            if (!pickupFriendSelect || !pickupFriendSelect.value) {
                log('Выберите друга для подбора из списка.');
                pickupActive = false;
                scheduleData.pickupInfo = null;
                resetPickupSelection();
            } else {
                pickupEntry = getFriendDataById(pickupFriendSelect.value);
                if (!pickupEntry) {
                    log('Выбранный друг не найден в списке.');
                    pickupActive = false;
                    scheduleData.pickupInfo = null;
                    resetPickupSelection();
                } else {
                    var pickupLat = Number(pickupEntry.friend.x_coord);
                    var pickupLng = Number(pickupEntry.friend.y_coord);
                    if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
                        log('У выбранного друга отсутствуют корректные координаты для подбора.');
                        pickupActive = false;
                        scheduleData.pickupInfo = null;
                        resetPickupSelection();
                    } else {
                        pickupPoint = {lat: pickupLat, lng: pickupLng};
                        pickupLabel = pickupEntry.friend.name || ('Друг #' + pickupEntry.friend.friend_id);
                        var pickupState = ensureFriendState(pickupEntry.friend, pickupEntry.index);
                        if (pickupState) {
                            pickupState.included = true;
                        }
                        renderFriendsList();
                    }
                }
            }
        }

        var targetPoint = {lat: Number(target.lat), lng: Number(target.lng)};
        var destinationPoint = null;
        if (hasDestination) {
            destinationPoint = {
                lat: Number(selectedDestination.point.lat),
                lng: Number(selectedDestination.point.lng)
            };
        }

        var sequence = Promise.resolve();
        var drawnAny = false;
        var friendDrawn = 0;

        function queueRoute(body, label, drawOptions, summaryOptions, onSuccess) {
            sequence = sequence.then(function () {
                return requestRoute(body, label).then(function (route) {
                    if (route) {
                        drawGeoJSON(route, route.properties && route.properties.graph, drawOptions || {});
                        renderRouteDetails(route, summaryOptions || {});
                        drawnAny = true;
                        if (typeof onSuccess === 'function') {
                            onSuccess(route);
                        }
                    }
                    return route;
                });
            });
        }

        var userSegmentIndex = 0;
        function addUserSegment(segment, scheduleIndex) {
            if (!segment || !segment.body) {
                return;
            }
            var drawOptions = {
                clear: userSegmentIndex === 0,
                color: segment.color,
                weight: 6,
                opacity: 0.95
            };
            var summaryOptions = {
                title: segment.title
            };
            if (userSegmentIndex > 0) {
                summaryOptions.append = true;
            }
            queueRoute(segment.body, segment.label, drawOptions, summaryOptions, function (route) {
                if (!scheduleData || !scheduleData.userSegments) {
                    return;
                }
                var entry = scheduleData.userSegments[scheduleIndex];
                if (!entry) {
                    return;
                }
                var effectiveDuration = extractRouteDuration(route);
                if (segment.stage === 'D') {
                    var split = splitDriveAndWalk(route);
                    if (split.parkingPoint) {
                        scheduleData.parkingInfo = split;
                    }
                    if (Number.isFinite(split.walkDurationSec) && split.walkDurationSec > 0) {
                        if (Number.isFinite(split.driveDurationSec)) {
                            effectiveDuration = split.driveDurationSec;
                        } else if (Number.isFinite(effectiveDuration)) {
                            effectiveDuration = Math.max(effectiveDuration - split.walkDurationSec, 0);
                        }
                        var walkEntry = {
                            label: 'Пешком до точки Б',
                            stage: 'walk',
                            durationSec: split.walkDurationSec
                        };
                        scheduleData.userSegments.splice(scheduleIndex + 1, 0, walkEntry);
                    } else if (Number.isFinite(split.driveDurationSec)) {
                        effectiveDuration = split.driveDurationSec;
                    }
                }
                entry.durationSec = effectiveDuration;
                entry.stage = segment.stage || entry.stage || 'user';
                entry.label = segment.title;
                if (!Number.isFinite(effectiveDuration)) {
                    scheduleData.missingDuration = true;
                }
            });
            userSegmentIndex += 1;
        }



        var pickupFriendIdStr = '';
        var userSegments = [];
        if (pickupActive && pickupEntry && pickupPoint) {
            pickupFriendIdStr = String(pickupEntry.friend.friend_id);
            scheduleData.pickupInfo = {friendId: pickupFriendIdStr, label: pickupLabel};
            var pickupSegment = createRouteBody(startPoint, pickupPoint, mergeOptions(userOptions, {
                startName: startLabel,
                destinationName: pickupLabel
            }));
            userSegments.push({
                body: pickupSegment,
                label: 'Пользователь: старт → ' + pickupLabel,
                color: '#1976d2',
                title: 'Пользователь: старт → ' + pickupLabel,
                stage: 'pickup'
            });

            var pickupToZSegment = createRouteBody(pickupPoint, targetPoint, mergeOptions(userOptions, {
                startName: pickupLabel,
                destinationName: 'Точка встречи'
            }));
            userSegments.push({
                body: pickupToZSegment,
                label: 'Пользователь: ' + pickupLabel + ' → точка встречи',
                color: '#1e88e5',
                title: 'Пользователь: ' + pickupLabel + ' → точка встречи',
                stage: 'Z'
            });
            log('Пользователь подберёт друга: ' + pickupLabel);
        } else {
            scheduleData.pickupInfo = null;
            var startToZSegment = createRouteBody(startPoint, targetPoint, mergeOptions(userOptions, {
                startName: startLabel,
                destinationName: 'Точка встречи'
            }));
            userSegments.push({
                body: startToZSegment,
                label: 'Пользователь: старт → точка встречи',
                color: '#1976d2',
                title: 'Пользователь: старт → точка встречи',
                stage: 'Z'
            });
            pickupActive = false;
            pickupFriendIdStr = '';
        }

        if (hasDestination && destinationPoint) {
            var zToDestinationSegment = createRouteBody(targetPoint, destinationPoint, mergeOptions(userOptions, {
                startName: 'Точка встречи',
                destinationName: destinationLabel || 'Точка Б'
            }));
            userSegments.push({
                body: zToDestinationSegment,
                label: 'Пользователь: точка встречи → точка Б',
                color: '#0d47a1',
                title: 'Пользователь: точка встречи → точка Б',
                stage: 'D'
            });

            var stopSegment = {
                body: null,
                label: 'Сбор и посадка',
                color: '#1976d2',
                title: 'Сбор и посадка',
                stage: 'stop',
                durationSec: scheduleData ? scheduleData.stopDurationSec : 180
            };
            var lastZIndex = -1;
            for (var idxSeg = 0; idxSeg < userSegments.length; idxSeg += 1) {
                if (userSegments[idxSeg].stage === 'Z') {
                    lastZIndex = idxSeg;
                }
            }
            if (lastZIndex >= 0) {
                userSegments.splice(lastZIndex + 1, 0, stopSegment);
            } else {
                userSegments.push(stopSegment);
            }
        }

        scheduleData.userSegments = [];
        for (var s = 0; s < userSegments.length; s += 1) {
            var segment = userSegments[s];
            var scheduleIndex = scheduleData.userSegments.push({
                label: segment.title,
                stage: segment.stage || 'user',
                durationSec: Number.isFinite(segment.durationSec) ? segment.durationSec : null
            }) - 1;
            if (segment.body) {
                addUserSegment(segment, scheduleIndex);
            } else {
                if (!Number.isFinite(scheduleData.userSegments[scheduleIndex].durationSec)) {
                    scheduleData.userSegments[scheduleIndex].durationSec = Number(segment.durationSec) || 0;
                    if (!Number.isFinite(scheduleData.userSegments[scheduleIndex].durationSec)) {
                        scheduleData.missingDuration = true;
                        scheduleData.userSegments[scheduleIndex].durationSec = 0;
                    }
                }
            }
        }

        var activeFriends = [];
        for (var i = 0; i < friendsData.length; i += 1) {
            var friend = friendsData[i];
            var state = ensureFriendState(friend, i);
            if (!state || state.included === false) {
                continue;
            }
            if (pickupActive && pickupFriendIdStr && String(friend.friend_id) === pickupFriendIdStr) {
                continue;
            }
            activeFriends.push({friend: friend, index: i});
        }

        sequence = sequence.then(function () {
            var friendSequence = Promise.resolve();
            activeFriends.forEach(function (entry) {
                friendSequence = friendSequence.then(function () {
                    return processFriendRoute(entry.friend, entry.index);
                });
            });
            return friendSequence.then(function () {
                scheduleData.friendSegments = scheduleData.friendSegments || [];
            });
        });

        function processFriendRoute(friend, index) {
            var state = ensureFriendState(friend, index);
            if (!state) {
                return Promise.resolve();
            }
            var friendLabel = friend.name || ('Друг #' + friend.friend_id);
            var lat = Number(friend.x_coord);
            var lng = Number(friend.y_coord);
            if (Number.isNaN(lat) || Number.isNaN(lng)) {
                log('У друга ' + friendLabel + ' отсутствуют корректные координаты.');
                return Promise.resolve();
            }
            var transportMode = mapFriendTransport(friend.mode);
            var cacheKey = getFriendCacheKey(transportMode, targetPoint);
            state.routes = state.routes || {};
            var cachedRoute = state.routes[cacheKey];
            var routePromise;
            if (cachedRoute) {
                log('Используем кэш маршрута для друга: ' + friendLabel);
                routePromise = Promise.resolve(cachedRoute);
            } else {
                var friendOptions = buildFriendRouteOptions(friend);
                friendOptions.startName = friendLabel;
                friendOptions.destinationName = 'Точка встречи';
                var friendBody = createRouteBody({lat: lat, lng: lng}, targetPoint, friendOptions);
                routePromise = requestRoute(friendBody, 'Друг: ' + friendLabel + ' → точка встречи').then(function (route) {
                    if (route) {
                        state.routes[cacheKey] = route;
                    }
                    return route;
                });
            }
            return routePromise.then(function (route) {
                if (route) {
                    drawGeoJSON(route, route.properties && route.properties.graph, {
                        clear: false,
                        color: state.color,
                        weight: 4,
                        opacity: 0.55,
                        graph: false,
                        dashArray: '6 8'
                    });
                    renderRouteDetails(route, {
                        append: true,
                        title: 'Друг: ' + friendLabel + ' → точка встречи',
                        hideSteps: true
                    });
                    drawnAny = true;
                    friendDrawn += 1;
                }
                if (scheduleData) {
                    var duration = extractRouteDuration(route);
                    scheduleData.friendSegments.push({
                        id: String(friend.friend_id || ''),
                        name: friendLabel,
                        durationSec: duration
                    });
                    if (!Number.isFinite(duration)) {
                        scheduleData.missingDuration = true;
                    }
                }
            });
        }

        sequence.then(function () {
            if (scheduleData) {
                scheduleData.ready = true;
            }
            restoreFriendsPanel();
            finalizeSchedule({ departureNow: true });
            if (!drawnAny && friendDrawn === 0) {
                log('Маршруты не построены. Проверьте исходные данные.');
                routeInfoEl.classList.add('hidden');
            }
        }).catch(function (error) {
            log('Не удалось построить маршруты: ' + error);
            if (scheduleData) {
                scheduleData.ready = false;
            }
            restoreFriendsPanel();
            renderScheduleMessage('Ошибка при расчёте маршрутов.');
        });
    }

    function applyPointAsStart() {
        if (!lastInspectedPoint) {
            log('Нет выбранной точки — кликните по карте или используйте поиск');
            return;
        }
        setStartPoint(lastInspectedPoint.point, lastInspectedPoint.name);
        if (map) {
            map.setView([lastInspectedPoint.point.lat, lastInspectedPoint.point.lng], Math.max(map.getZoom(), 13));
        }
    }

    function applyPointAsDestination() {
        if (!lastInspectedPoint) {
            log('Нет выбранной точки — кликните по карте или используйте поиск');
            return;
        }
        applyDestination(lastInspectedPoint);
    }

    searchButton.addEventListener('click', searchPlaces);
    searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchPlaces();
        }
    });
    if (selectStartButton) {
        selectStartButton.addEventListener('click', function () {
            selectingStart = true;
            selectStartButton.classList.add('active');
            log('Кликните по карте, чтобы выбрать точку А');
        });
    }
    geolocationButton.addEventListener('click', useGeolocation);
    openRouteButton.addEventListener('click', function () {
        openRoute().catch(function (error) {
            log('Не удалось запустить расчёт маршрутов: ' + (error && error.message ? error.message : String(error)));
        });
    });
    setPointStartButton.addEventListener('click', applyPointAsStart);
    setPointDestinationButton.addEventListener('click', applyPointAsDestination);
    if (pickupEnable) {
        pickupEnable.addEventListener('change', function () {
            if (!pickupEnable.checked) {
                pickupFriendId = '';
                if (pickupFriendSelect) {
                    pickupFriendSelect.value = '';
                }
            } else if (pickupFriendSelect && (pickupFriendSelect.options.length <= 1 || pickupFriendSelect.disabled)) {
                log('Некого подбирать: список друзей пуст.');
                pickupEnable.checked = false;
            } else if (pickupFriendSelect && !pickupFriendSelect.value) {
                log('Выберите друга для подбора из списка.');
            }
        });
    }

    if (transportSelect) {
        transportSelect.addEventListener('change', function () {
            updateTransportUi();
            scheduleMeetpointRecalculation();
        });
    }
    if (pickupFriendSelect) {
        pickupFriendSelect.addEventListener('change', function () {
            pickupFriendId = pickupFriendSelect.value || '';
            if (pickupFriendId) {
                if (pickupEnable && !pickupEnable.checked) {
                    pickupEnable.checked = true;
                }
                var info = getFriendDataById(pickupFriendId);
                if (info) {
                    var state = ensureFriendState(info.friend, info.index);
                    if (state && state.included === false) {
                        state.included = true;
                        renderFriendsList();
                    } else {
                        updatePickupOptions();
                    }
                }
            } else {
                if (pickupEnable) {
                    pickupEnable.checked = false;
                }
                updatePickupOptions();
            }
        });
    }

    if (friendsToggle) {
        friendsToggle.addEventListener('click', function () {
            toggleFriendsPanel();
        });
    }
    if (calculateScheduleButton) {
        calculateScheduleButton.addEventListener('click', function () {
            finalizeSchedule();
        });
    }
    if (arrivalTimeInput) {
        arrivalTimeInput.addEventListener('change', function () {
            finalizeSchedule();
        });
    }

    $('load-sample').addEventListener('click', fetchSample);
    $('upload-script').addEventListener('click', uploadScript);
    $('optimize').addEventListener('click', optimize);

    updatePickupOptions();
    updatePickupControlsVisibility();

    loadFriends().catch(function (error) {
        log('Не удалось загрузить список друзей: ' + (error && error.message ? error.message : String(error)));
        scheduleMeetpointRecalculation();
    });

    waitForDG();
    updateTransportUi();
}());





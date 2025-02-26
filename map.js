mapboxgl.accessToken = 'pk.eyJ1IjoiaHNmbG9yZXMiLCJhIjoiY203ZWFtdzRmMGMwNzJpb2didWx2M2NkdiJ9.KIpWelVbTn9w3P1Zd7xn6Q';

// =======================================
// Configuration Constants
// =======================================
const CIRCLE_SIZE_MIN = 5;    // Minimum circle radius
const CIRCLE_SIZE_MAX = 25;   // Maximum circle radius
const HOVER_MULTIPLIER = 1.2;  // How much the circle grows on hover

// =======================================
// Global Variables for Filtering
// =======================================
let timeFilter = -1;             // -1 means "any time" (no filtering)
let tripsGlobal = [];            // All trip data from CSV
let filteredTrips = [];          // Trips after filtering
let filteredArrivals = new Map();
let filteredDepartures = new Map();
let filteredStations = [];       // Stations with updated (filtered) counts
let unfilteredMax = 0;           // Global maximum totalTraffic from unfiltered data

// Quantize scale for traffic flow color (maps a ratio to discrete steps)
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// =======================================
// Helper Functions
// =======================================

// Format minutes since midnight into a time string (e.g., "8:30 AM")
function formatTime(minutes) {
    const date = new Date(0, 0, 0, 0, minutes);
    return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Convert a Date object to minutes since midnight
function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

// Global placeholder for the filtering function (to be defined later)
let filterTripsByTime = function () { };

// =======================================
// Slider Setup
// =======================================
const timeSlider = document.getElementById('time-slider');
const selectedTime = document.getElementById('selected-time');
const anyTimeLabel = document.getElementById('any-time');

function updateTimeDisplay() {
    timeFilter = Number(timeSlider.value);
    if (timeFilter === -1) {
        selectedTime.textContent = '';
        anyTimeLabel.style.display = 'block';
    } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = 'none';
    }
    filterTripsByTime();
}
timeSlider.addEventListener('input', updateTimeDisplay);
updateTimeDisplay();

// =======================================
// Map Initialization
// =======================================
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18
});

map.on('load', () => {
    // ---------------------------------------
    // 1. Add Bike Lanes for Boston & Cambridge
    // ---------------------------------------
    const bikeLaneStyle = {
        'line-color': '#32D400',
        'line-width': 5,
        'line-opacity': 0.6
    };

    map.addSource('boston_route', {
        type: 'geojson',
        data: 'Existing_Bike_Network_2022.geojson'  // Ensure this file exists
    });
    map.addLayer({
        id: 'boston-bike-lanes',
        type: 'line',
        source: 'boston_route',
        paint: bikeLaneStyle
    });

    map.addSource('cambridge_route', {
        type: 'geojson',
        data: 'cambridge-bike-lanes.geojson'  // Ensure this file exists
    });
    map.addLayer({
        id: 'cambridge-bike-lanes',
        type: 'line',
        source: 'cambridge_route',
        paint: bikeLaneStyle
    });

    // ---------------------------------------
    // 2. Add Station Markers
    // ---------------------------------------
    const svg = d3.select('#map').select('svg');
    let stations = []; // To hold station objects loaded from bikestations.json

    // Convert station coordinates (lon/lat) to pixel coordinates
    function getCoords(station) {
        const point = new mapboxgl.LngLat(+station.lon, +station.lat);
        const { x, y } = map.project(point);
        return { cx: x, cy: y };
    }

    d3.json('bikestations.json').then(jsonData => {
        stations = jsonData.data.stations;
        // Append a circle for each station
        const circles = svg.selectAll('circle')
            .data(stations)
            .enter()
            .append('circle')
            .attr('r', 5)  // Initial radius; will be updated by filtering
            .attr('fill', 'steelblue')
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .attr('opacity', 0.8)
            .style('pointer-events', 'auto'); // Enable hover events

        // Update positions of circles on map movements
        function updatePositions() {
            circles.attr('cx', d => getCoords(d).cx)
                .attr('cy', d => getCoords(d).cy);
        }
        updatePositions();
        map.on('move', updatePositions);
        map.on('zoom', updatePositions);
        map.on('resize', updatePositions);
        map.on('moveend', updatePositions);

        // ---------------------------------------
        // 3. Load and Process Traffic Data
        // ---------------------------------------
        const trafficUrl = 'bluebikes-traffic-2024-03.csv';  // Ensure this file is accessible
        d3.csv(trafficUrl).then(trips => {
            tripsGlobal = trips;
            tripsGlobal.forEach(trip => {
                trip.started_at = new Date(trip.started_at);
                trip.ended_at = new Date(trip.ended_at);
            });

            // Pre-sort trips into buckets: one bucket for each minute (0–1439)
            let departuresByMinute = Array.from({ length: 1440 }, () => []);
            let arrivalsByMinute = Array.from({ length: 1440 }, () => []);
            tripsGlobal.forEach(trip => {
                let startMin = minutesSinceMidnight(trip.started_at);
                let endMin = minutesSinceMidnight(trip.ended_at);
                departuresByMinute[startMin].push(trip);
                arrivalsByMinute[endMin].push(trip);
            });

            // Helper: Given a bucketed array, extract trips in a ±60-minute window around a given minute.
            function filterByMinute(tripsByMinute, minute) {
                let minMinute = (minute - 60 + 1440) % 1440;
                let maxMinute = (minute + 60) % 1440;
                if (minMinute > maxMinute) {
                    let beforeMidnight = tripsByMinute.slice(minMinute);
                    let afterMidnight = tripsByMinute.slice(0, maxMinute);
                    return beforeMidnight.concat(afterMidnight).flat();
                } else {
                    return tripsByMinute.slice(minMinute, maxMinute).flat();
                }
            }

            // Define filterTripsByTime using the bucket approach
            filterTripsByTime = function () {
                if (timeFilter === -1) {
                    // No filter: use all trips
                    filteredDepartures = d3.rollup(
                        departuresByMinute.flat(),
                        v => v.length,
                        d => d.start_station_id
                    );
                    filteredArrivals = d3.rollup(
                        arrivalsByMinute.flat(),
                        v => v.length,
                        d => d.end_station_id
                    );
                } else {
                    // Filter trips to within ±60 minutes of timeFilter
                    filteredDepartures = d3.rollup(
                        filterByMinute(departuresByMinute, timeFilter),
                        v => v.length,
                        d => d.start_station_id
                    );
                    filteredArrivals = d3.rollup(
                        filterByMinute(arrivalsByMinute, timeFilter),
                        v => v.length,
                        d => d.end_station_id
                    );
                }
                // Build a new array of station objects with updated traffic counts
                filteredStations = stations.map(station => {
                    let st = { ...station };
                    let id = st.short_name;
                    st.departures = filteredDepartures.get(id) ?? 0;
                    st.arrivals = filteredArrivals.get(id) ?? 0;
                    st.totalTraffic = st.departures + st.arrivals;
                    return st;
                });
                if (timeFilter === -1) {
                    unfilteredMax = d3.max(filteredStations, d => d.totalTraffic) || 0;
                }
                // Create a constant scale using our global unfilteredMax and configured range
                const radiusScaleFiltered = d3.scaleSqrt()
                    .domain([0, unfilteredMax])
                    .range([CIRCLE_SIZE_MIN, CIRCLE_SIZE_MAX]);
                // Update circle radii immediately (without transition)
                svg.selectAll('circle')
                    .attr('r', d => {
                        let fs = filteredStations.find(s => s.short_name === d.short_name);
                        return fs ? radiusScaleFiltered(fs.totalTraffic) : 0;
                    });
                // Update the CSS custom property for color (traffic flow)
                svg.selectAll('circle')
                    .style("--departure-ratio", d => {
                        let fs = filteredStations.find(s => s.short_name === d.short_name);
                        let ratio = fs && fs.totalTraffic > 0 ? fs.departures / fs.totalTraffic : 0;
                        return stationFlow(ratio);
                    });
            };

            // Run the filter function initially
            filterTripsByTime();
        }).catch(error => {
            console.error("Error loading traffic data:", error);
        });

        // ---------------------------------------
        // 4. Set Up Custom Tooltip and Hover Effects
        // ---------------------------------------
        const tooltip = d3.select("body")
            .append("div")
            .attr("id", "tooltip")
            .style("position", "absolute")
            .style("background", "rgba(255, 255, 255, 0.9)")
            .style("padding", "8px")
            .style("border", "1px solid #ccc")
            .style("border-radius", "4px")
            .style("pointer-events", "none")
            .style("opacity", 0)
            .style("z-index", "10000");

        svg.selectAll('circle')
            .on("mouseover", function (event, d) {
                let fs = filteredStations.find(s => s.short_name === d.short_name);
                const radiusScaleFiltered = d3.scaleSqrt()
                    .domain([0, unfilteredMax])
                    .range([CIRCLE_SIZE_MIN, CIRCLE_SIZE_MAX]);
                let defaultRadius = fs ? radiusScaleFiltered(fs.totalTraffic) : 0;
                d3.select(this)
                    .transition().duration(200)
                    .attr("r", defaultRadius * HOVER_MULTIPLIER);
                tooltip.transition().duration(200).style("opacity", 1);
                tooltip.html(
                    fs
                        ? `<strong>${fs.totalTraffic} trips</strong><br>${fs.departures} departures, ${fs.arrivals} arrivals`
                        : "No data"
                );
            })
            .on("mousemove", function (event, d) {
                tooltip.style("left", (event.pageX + 10) + "px")
                    .style("top", (event.pageY + 10) + "px");
            })
            .on("mouseout", function (event, d) {
                let fs = filteredStations.find(s => s.short_name === d.short_name);
                const radiusScaleFiltered = d3.scaleSqrt()
                    .domain([0, unfilteredMax])
                    .range([CIRCLE_SIZE_MIN, CIRCLE_SIZE_MAX]);
                let defaultRadius = fs ? radiusScaleFiltered(fs.totalTraffic) : 0;
                d3.select(this)
                    .transition().duration(200)
                    .attr("r", defaultRadius);
                tooltip.transition().duration(200).style("opacity", 0);
            });
    }).catch(error => {
        console.error("Error loading station data:", error);
    });
});

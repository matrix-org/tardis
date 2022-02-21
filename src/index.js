import * as d3 from 'd3';
import * as d3dag from 'd3-dag';

async function postData(url = '', data = {}) {
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return response.json();
}

// global cache of events. NO METADATA ON THESE.
let eventsGlobalCache = {};
let roomIdToLatestEventsCache = {}; // room_id => latest events object
let prevEventsHopsBack = 5;
let authEventsHopsBack = 5;

const flags = {
    showAuthDag: false,
    showMissing: true,
    showOutliers: true,
}

window.onload = async (event) => {
    let roomId;
    let host = "http://localhost:18008";

    const hookupCheckbox = (domId, flagName) => {
        const checkbox = document.getElementById(domId);
        checkbox.addEventListener("change", () => {
            flags[flagName] = checkbox.checked;
            loadDag(host, roomId);
        });
        checkbox.checked = flags[flagName];
    }

    document.getElementById("homeserver").value = host;
    document.getElementById("roomid").addEventListener("blur", (ev) => {
        roomId = ev.target.value;
        loadDag(host, roomId);
    });
    document.getElementById("homeserver").addEventListener("blur", (ev) => {
        host = ev.target.value;
        loadDag(host, roomId);
    });
    document.getElementById("closeinfocontainer").addEventListener("click", (ev) => {
        document.getElementById("infocontainer").style = "display: none;";
    })
    hookupCheckbox("showauthevents", "showAuthDag");
    // hookupCheckbox("showmissing", "showMissing");
    hookupCheckbox("showoutliers", "showOutliers");
    document.getElementById("infocontainer").style = "display: none;";

}

// walk backwards from the `frontierEvents` (event_id -> Event JSON) given, using the `lookupKey` to find earlier events.
// Stops when there is nowhere to go (create event) or when `hopsBack` has been reached.
// Returns:
// {
//   events: {...} a map of event ID to event.
//   frontiers: {...} the new frontier events (a map of event ID to event)
// }
const loadEarlierEvents = async(host, frontierEvents, lookupKey, hopsBack) => {
    console.log("loadEarlierEvents", frontierEvents);
    let result = {}; // event_id -> Event JSON
    for (let i = 0; i < hopsBack; i++) {
        // walk the DAG backwards starting at the frontier entries
        let missingEventIds = {};
        for (const frontier of Object.values(frontierEvents)) {
            for (const refId of frontier[lookupKey]) {
                if (!(refId in result)) {
                    missingEventIds[refId] = 1;
                }
            }
        }
        console.log("hop ", i+1, "/", hopsBack, Object.keys(frontierEvents), " -> ", Object.keys(missingEventIds));
        if (Object.keys(missingEventIds).length === 0) {
            break;
        }
        // missingEventIds now contains the prev|auth events for the frontier entries, let's fetch them.
        const eventsById = await fetchEvents(host, Object.keys(missingEventIds));
        const events = Object.values(eventsById);
        if (events.length > 0) {
            frontierEvents = {};
            for (const event of events) {
                result[event._event_id] = event;
                delete missingEventIds[event._event_id];
                // these events now become frontiers themselves
                frontierEvents[event._event_id] = event;
            }
        }

        // fill in placeholders for missing events
        for (const missingEventId of Object.keys(missingEventIds)) {
            console.log(`Synthesising missing event ${missingEventId}`);
            result[missingEventId] = {
                _event_id: missingEventId,
                prev_events: [],
                auth_events: [],
                type: 'missing',
            }
        }
    }
    // the remaining frontier events need entries in the result for prev_events|auth_events - they aren't "missing", they just need to be loaded
    for (const frontier of Object.values(frontierEvents)) {
        frontier[lookupKey].forEach((prevEventId) => {
            if (result[prevEventId]) {
                return;
            }
            result[prevEventId] = {
                _event_id: prevEventId,
                _backwards_extremity_key: lookupKey,
                prev_events: [],
                auth_events: [],
                type: '...',
            }
        });
    }
    return {
        events: result,
        frontiers: frontierEvents,
    };
}

// Returns: { event_id: JSON }
const fetchEvents = async(host, eventIds) => {
    // fetch as many locally as possible
    let result = {};
    let toFetch = [];
    eventIds.forEach((eid) => {
        if (eventsGlobalCache[eid]) {
            result[eid] = eventsGlobalCache[eid];
            return;
        }
        toFetch.push(eid);
    });
    if (toFetch.length > 0) {
        const eventsById = await postData(
            `${host}/api/roomserver/queryEventsByID`,
            { 'event_ids': toFetch },
        );
        for (const event of eventsById.events) {
            eventsGlobalCache[event._event_id] = event;
            result[event._event_id] = event;
        }
    }
    const gotEvents = Object.keys(result).length;
    if (gotEvents != eventIds.length) {
        console.warn("fetchEvents asked for " + eventIds.length + " events, only got " + gotEvents);
    }
    // always return copies
    return JSON.parse(JSON.stringify(result));
}

// Returns: { create_event_id: $abc123, latest_events: [ JSON, JSON ]}
const loadLatestEvents = async(host, roomId) => {
    // {
    //   state_events: [ { EVENT JSON } ]
    //   latest_events: [
    //     [ $eventid, { sha256: ... } ],
    //     ...
    //   ]
    // }
    const latestEventsAndState = await postData(
        `${host}/api/roomserver/queryLatestEventsAndState`,
        { 'room_id': roomId },
    );
    let rootId;
    // grab the state events
    for (const event of latestEventsAndState.state_events) {
        if (event.type === 'm.room.create' && event.state_key === "") {
            rootId = event._event_id;
            break;
        }
    }

    // add in the latest events
    const latestEvents = await fetchEvents(host, latestEventsAndState.latest_events.map((e)=>e[0]));
    for (const event of Object.values(latestEvents)) {
        event.forward_extremity = true;
        latestEvents[event._event_id] = event;
    }
    return {
        create_event_id: rootId,
        latest_events: latestEvents,
    }
}

const loadDag = async(host, roomId) => {
    const showAuthDag = flags.showAuthDag;
    const hideMissingEvents = !flags.showMissing;
    const hideOrphans = !flags.showOutliers;
    document.getElementById("svgcontainer").innerHTML = "";

    const width = window.innerWidth;
    const height = window.innerHeight;

    let latestEvents;// = roomIdToLatestEventsCache[roomId];
    if (!latestEvents) {
        latestEvents = await loadLatestEvents(host, roomId);
        // roomIdToLatestEventsCache[roomId] = latestEvents;
        // TODO: cache without leaking between runs
    }
    const eventsToRender = latestEvents.latest_events;

    // spider some prev events
    const prevEvents = await loadEarlierEvents(host, latestEvents.latest_events, "prev_events", prevEventsHopsBack);
    let earlierEvents = Object.values(prevEvents.events);
    if (showAuthDag) {
        console.log("create", latestEvents.create_event_id);
        // spider some auth events
        const dagPortion = prevEvents.events;
        console.log("dag latest only:", Object.keys(latestEvents.latest_events));
        for (const event of Object.values(latestEvents.latest_events)) {
            dagPortion[event._event_id] = event;
        }
        
        const authEvents = await loadEarlierEvents(host, dagPortion, "auth_events", authEventsHopsBack);
        // We don't care about the prev_events for auth chain events, so snip them
        // We also don't care about the link to the create event as all events have this so it's just noise, so snip it.
        let createInChain = false;
        for (let authEvent of Object.values(authEvents.events)) {
            console.log("processing auth event ", authEvent._event_id, " prevs=", authEvent.prev_events);
            if (dagPortion[authEvent._event_id]) {
                console.log("event ", authEvent._event_id, " is in DAG, keeping prevs");
                continue; // the auth event is part of the dag, we DO care about prev_events
            }
            authEvent.prev_events = [];
            if (authEvent.auth_events.length == 1 && authEvent.auth_events.includes(latestEvents.create_event_id)) {
                createInChain = true;
                continue; // don't strip the create event ref if it is the only one (initial member event has this)
            }
            // remove the create event from auth_events for this auth event
            authEvent.auth_events = authEvent.auth_events.filter((id) => { return id !== latestEvents.create_event_id; })
        }
        // we don't want the m.room.create event unless it is part of the dag, as it will be orphaned
        // due to not having auth events linking to it.
        if (!dagPortion[latestEvents.create_event_id] && !createInChain) {
            delete eventsToRender[latestEvents.create_event_id];
            delete authEvents.events[latestEvents.create_event_id];
        }
        earlierEvents = earlierEvents.concat(Object.values(authEvents.events));
    }

    for (const event of earlierEvents) {
        eventsToRender[event._event_id] = event;
    }
    
    /*
    // tag events which receive multiple references
    for (const event of earlierEvents) {
        let prevIds = event.prev_events;
        if (showAuthDag) {
            prevIds = prevIds.concat(event.auth_events);
        }
        for (const parentId of prevIds) {
            if (!events[parentId]) {
                events[parentId] = {
                    _event_id: parentId,
                    prev_events: [],
                    auth_events: [],
                    refs: 1,
                    type: '...',
                };
                continue;
            }
            events[parentId].refs = events[parentId].refs ? (events[parentId].refs + 1) : 1;
        }
    } */

    // stratify the events into a DAG
    console.log(eventsToRender);
    const dag = d3dag.dagStratify()
        .id((event) => event._event_id)
        .linkData((target, source) => { return { auth: source.auth_events.includes(target._event_id) } })
        .parentIds((event) => {
            if (showAuthDag) {
                return event.prev_events.concat(event.auth_events.filter(id=>id!=latestEvents.create_event_id));
            } else {
                return event.prev_events;
            }
        })(Object.values(eventsToRender));

    console.log(dag);

    if (hideOrphans) {
        if (dag.id === undefined) {
            // our root is an undefined placeholder, which means we have orphans
            dag.children = dag.children.filter(node=>(node.children.length > 0));
        }
    }

    const nodeRadius = 10;
    const margin = nodeRadius * 4;
    const svgNode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgNode.setAttribute("width", width);
    svgNode.setAttribute("height", height);
    svgNode.setAttribute("viewBox", `${-margin} ${-margin} ${width + 10 * margin} ${height + 2 * margin}`);

    const svgSelection = d3.select(svgNode);
    const defs = svgSelection.append('defs');

    // below is derived from
    // https://observablehq.com/@erikbrinkman/d3-dag-sugiyama-with-arrows

    // d3dag.zherebko()
    d3dag.sugiyama()
        .layering(d3dag.layeringCoffmanGraham().width(2))
        .size([width, height])(dag);

    const steps = dag.size();
    const interp = d3.interpolateRainbow;
    const colorMap = {};
    dag.each((node, i) => {
        colorMap[node.id] = interp(i / steps);
    });

    // How to draw edges
    const line = d3.line()
        .curve(d3.curveCatmullRom)
        .x((d) => d.x)
        .y((d) => d.y);

    // Plot edges
    svgSelection.append('g')
        .selectAll('path')
        .data(dag.links())
        .enter()
        //.filter(({data})=>!data.auth)
        .append('path')
        .attr('d', ({data}) => line(data.points))
        .attr('fill', 'none')
        .attr('stroke-width', 3)
        .attr('stroke', (dagLink) => {
            const source = dagLink.source;
            const target = dagLink.target;
            
            const gradId = `${source.id}-${target.id}`;
            const grad = defs.append('linearGradient')
                .attr('id', gradId)
                .attr('gradientUnits', 'userSpaceOnUse')
                .attr('x1', source.x)
                .attr('x2', target.x)
                .attr('y1', source.y)
                .attr('y2', target.y);

            /*
            grad.append('stop')
                .attr('offset', '0%').attr('stop-color', colorMap[source.id]);
            grad.append('stop')
                .attr('offset', '100%').attr('stop-color', colorMap[target.id]); */
            grad.append('stop')
                .attr('offset', '0%').attr('stop-color', dagLink.data.auth ? colorMap[source.id] : '#000');
            grad.append('stop')
                .attr('offset', '100%').attr('stop-color', dagLink.data.auth ? colorMap[target.id] : '#000');
            return `url(#${gradId})`;
        });

    // Select nodes
    const nodes = svgSelection.append('g')
        .selectAll('g')
        .data(dag.descendants())
        .enter()
        .append('g')
        .attr('transform', ({x, y}) => `translate(${x}, ${y})`);

    // Plot node circles
    nodes.append('circle')
        .attr('r', nodeRadius)
        .attr('fill', (n) => colorMap[n.id]);

/*
    const arrow = d3.symbol().type(d3.symbolTriangle).size(nodeRadius * nodeRadius / 5.0);
    svgSelection.append('g')
        .selectAll('path')
        .data(dag.links())
        .enter()
        .append('path')
        .attr('d', arrow)
        .attr('transform', ({
            source,
            target,
            data,
        }) => {
            const [end, start] = data.points.reverse();
            // This sets the arrows the node radius (20) + a little bit (3)
            // away from the node center, on the last line segment of the edge.
            // This means that edges that only span ine level will work perfectly,
            // but if the edge bends, this will be a little off.
            const dx = start.x - end.x;
            const dy = start.y - end.y;
            const scale = nodeRadius * 1.15 / Math.sqrt(dx * dx + dy * dy);
            // This is the angle of the last line segment
            const angle = Math.atan2(-dy, -dx) * 180 / Math.PI + 90;
            // console.log(angle, dx, dy);
            return `translate(${end.x + dx * scale}, ${end.y + dy * scale}) rotate(${angle})`;
        })
        .attr('fill', ({target}) => colorMap[target.id])
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5);
*/

    // Add text to nodes with border
    nodes.append('text')
        .text((d) => d.data.type)
        .attr('transform', `translate(${nodeRadius + 10}, 0)`)
        .attr('font-family', 'sans-serif')
        .attr('text-anchor', 'left')
        .attr('alignment-baseline', 'middle')
        .attr('fill', 'white')
        .attr('opacity', 0.7)
        .attr('stroke', 'white')
        .attr('stroke-width', 4);

    nodes.append('text')
        .text((d) => d.data.type)
        .attr('cursor', 'pointer')
        .on("click", async (d) => {
            if (d.data._backwards_extremity_key) {
                // load more events
                await loadEarlierEvents(host, {[d.data._event_id]: {
                    [d.data._backwards_extremity_key]: [d.data._event_id],
                }}, d.data._backwards_extremity_key, 1);
                if (d.data._backwards_extremity_key === "prev_events") {
                    prevEventsHopsBack += 5;
                } else if (d.data._backwards_extremity_key === "auth_events") {
                    authEventsHopsBack += 5;
                } else {
                    console.warn("unknown backwards extremity key: ", d.data._backwards_extremity_key)
                }
                loadDag(host, roomId);
                return;
            }
            document.getElementById("eventdetails").textContent = JSON.stringify(d.data, null, 2);
            document.getElementById("infocontainer").style = "display: block;"
        })
        .attr('transform', `translate(${nodeRadius + 10}, 0)`)
        .attr('font-family', 'sans-serif')
        .attr('text-anchor', 'left')
        .attr('alignment-baseline', 'middle')
        .attr('fill', (d) => d.data.forward_extremity ? 'red' : 'black');

    d3.select('#svgcontainer').append(()=>svgNode);
};

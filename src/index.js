import * as d3 from 'd3';
import * as d3dag from 'd3-dag';

async function postData(url = '', data = {}) {
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return response.json();
}

let host = "http://localhost:18008";
let roomId;

const flags = {
    showAuthDag: false,
    showMissing: true,
    showOutliers: true,
}

const hookupCheckbox = (domId, flagName) => {
    const checkbox = document.getElementById(domId);
    checkbox.addEventListener("change", () => {
        flags[flagName] = checkbox.checked;
        loadDag();
    });
    checkbox.checked = flags[flagName];
}

window.onload = async (event) => {
    document.getElementById("homeserver").value = host;
    document.getElementById("roomid").addEventListener("blur", (ev) => {
        roomId = ev.target.value;
        loadDag();
    });
    document.getElementById("homeserver").addEventListener("blur", (ev) => {
        host = ev.target.value;
        loadDag();
    });
    hookupCheckbox("showauthevents", "showAuthDag");
    hookupCheckbox("showmissing", "showMissing");
    hookupCheckbox("showoutliers", "showOutliers");

}

// walk backwards from the `frontierEvents` given, using the `lookupKey` to find earlier events.
// Stops when there is nowhere to go (create event) or when `hopsBack` has been reached.
// Returns a map of event ID to event.
const loadEarlierEvents = async(frontierEvents, lookupKey, hopsBack) => {
    let result = {}; // event_id -> Event JSON
    let hop = 0;
    do {
        // walk the DAG backwards starting at the frontier entries
        let missingEventIds = {};
        for (const frontier of Object.values(frontierEvents)) {
            for (const refId of frontier[lookupKey]) {
                if (!(refId in result)) {
                    missingEventIds[refId] = 1;
                }
            }
        }
        console.log("hop ", hop, "/", hopsBack, Object.keys(frontierEvents), " -> ", Object.keys(missingEventIds));
        if (Object.keys(missingEventIds).length === 0) {
            return result;
        }
        // missingEventIds now contains the prev|auth events for the frontier entries, let's fetch them.
        const eventsById = await postData(
            `${host}/api/roomserver/queryEventsByID`,
            { 'event_ids': Object.keys(missingEventIds) },
        );
        if (eventsById && eventsById.events && eventsById.events.length > 0) {
            frontierEvents = {};
            for (const event of eventsById.events) {
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
        hop++;
    } while(hop < hopsBack);
    return result;
}

const loadDag = async() => {
    const showStateEvents = true;
    const showAuthDag = flags.showAuthDag;
    const hideMissingEvents = !flags.showMissing;
    const hideOrphans = !flags.showOutliers;
    document.getElementById("svgcontainer").innerHTML = "";

    const width = window.innerWidth;
    const height = window.innerHeight;

    const events = {};
    let rootId;

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

    // grab the state events
    if (showStateEvents) {
        for (const event of latestEventsAndState.state_events) {
            events[event._event_id] = event;
            if (event.type === 'm.room.create' && event.state_key === "") {
                rootId = event._event_id;
            }
        }
    }

    // add in the latest events
    let latestEvents = {};
    const eventsById = await postData(
        `${host}/api/roomserver/queryEventsByID`,
        { 'event_ids': latestEventsAndState.latest_events.map((e)=>e[0]) },
    );
    for (const event of eventsById.events) {
        events[event._event_id] = event;
        latestEvents[event._event_id] = event;
    }

    // spider some prev events    
    const prevEvents = await loadEarlierEvents(latestEvents, "prev_events", 5); // TODO: config hops back

    // tag events which receive multiple references
    for (const event of Object.values(prevEvents)) {
        if (hideMissingEvents) {
            if (event.type === 'missing') {
                continue;
            }
            event.prev_events = event.prev_events.filter(id=>(events[id].type !== 'missing'));
            event.auth_events = event.auth_events.filter(id=>(events[id].type !== 'missing'));
        }
        events[event._event_id] = event;

        for (const parentId of event.prev_events.concat(event.auth_events)) {
            events[parentId].refs = events[parentId].refs ? (events[parentId].refs + 1) : 1;
        }
    }

    function shouldSkipParent(event) {
        if (event.prev_events.length !== 1) {
            return false;
        }
        const parent = events[event.prev_events[0]];
        if (!parent) {
            return false;
        }
        if (parent.prev_events.length == 1 && parent.refs == 1) {
            return true;
        }
        return false;
    }

    const skipBoringParents = false;
    if (skipBoringParents) {
        // collapse linear strands of the DAG (based on prev_events)
        for (const event of Object.values(events)) {
            if (event.skipped) continue;
            while (shouldSkipParent(event)) {
                const parent = events[event.prev_events[0]];
                console.log(`Skipping boring parent ${parent._event_id}`);
                event.prev_events = parent.prev_events;
                parent.skipped = true;
            }
        }

        // prune the events which were skipped
        for (const event of Object.values(events)) {
            if (event.skipped) delete events[event._event_id];
        }
    }
    //return;
    //console.log(JSON.stringify(events));

    let parentIdFn;
    if (showAuthDag) {
        parentIdFn = (event) => event.prev_events.concat(event.auth_events.filter(id=>id!=rootId));
    }
    else {
        parentIdFn = (event) => event.prev_events;
    }

    // stratify the events into a DAG
    console.log(events);
    const dag = d3dag.dagStratify()
        .id((event) => event._event_id)
        .linkData((target, source) => { return { auth: source.auth_events.includes(target._event_id) } })
        .parentIds(parentIdFn)(Object.values(events));

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
        .attr('stroke', ({source, target}) => {
            const gradId = `${source.id}-${target.id}`;
            const grad = defs.append('linearGradient')
                .attr('id', gradId)
                .attr('gradientUnits', 'userSpaceOnUse')
                .attr('x1', source.x)
                .attr('x2', target.x)
                .attr('y1', source.y)
                .attr('y2', target.y);
            grad.append('stop')
                .attr('offset', '0%').attr('stop-color', colorMap[source.id]);
            grad.append('stop')
                .attr('offset', '100%').attr('stop-color', colorMap[target.id]);
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
        .attr('transform', `translate(${nodeRadius + 10}, 0)`)
        .attr('font-family', 'sans-serif')
        .attr('text-anchor', 'left')
        .attr('alignment-baseline', 'middle')
        .attr('fill', 'black');

    d3.select('#svgcontainer').append(()=>svgNode);
};

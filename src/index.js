import * as d3 from 'd3';
import * as d3dag from 'd3-dag';

async function postData(url = '', data = {}) {
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return response.json();
}

const host = 'http://localhost:8008';
const roomId = '!MMLsEB4klBO4GToM:bucephalus';

window.onload = async (event) => {
    const limit = 300000;
    const events = {};
    const latestEventsAndState = await postData(
        `${host}/api/roomserver/queryLatestEventsAndState`,
        { 'room_id': roomId },
    );

    const showStateEvents = false;
    // grab the state events
    if (showStateEvents) {
        for (const event of latestEventsAndState.state_events) {
            events[event._event_id] = event;
        }
    }

    // add in the latest events
    const eventsById = await postData(
        `${host}/api/roomserver/queryEventsByID`,
        { 'event_ids': latestEventsAndState.latest_events.map((e)=>e[0]) },
    );
    for (const event of eventsById.events) {
        events[event._event_id] = event;
    }

    // spider some prev events    
    let missingEventIds;
    let missing;
    let rootId;
    do {
        missing = false;
        missingEventIds = {};
        for (const event of Object.values(events)) {
            if (event.type === 'm.room.create') rootId = event._event_id;
            if (event.state_key) event.prev_events = []; 
            for (const refId of event.prev_events.concat(event.auth_events)) {
                if (!(refId in events)) {
                    missingEventIds[refId] = 1;
                    missing = true;
                }
            }
        }
        if (Object.keys(missingEventIds).length > 0 && Object.keys(events).length < limit) {
            const eventsById = await postData(
                `${host}/api/roomserver/queryEventsByID`,
                { 'event_ids': Object.keys(missingEventIds) },
            );
            if (eventsById && eventsById.events && eventsById.events.length > 0) {
                for (const event of eventsById.events) {
                    events[event._event_id] = event;
                    delete missingEventIds[event._event_id];
                }
            }
        }

        // fill in placeholders for missing events
        for (const missingEventId of Object.keys(missingEventIds)) {
            console.log(`Synthesising missing event ${missingEventId}`);
            events[missingEventId] = {
                _event_id: missingEventId,
                prev_events: [],
                auth_events: [],
                type: 'missing',
            }
        }
    } while(missing);

    const hideMissingEvents = true;
    // tag events which receive multiple references
    for (const event of Object.values(events)) {
        if (hideMissingEvents) {
            if (event.type === 'missing') {
                delete events[event._event_id];
                continue;
            }
            event.prev_events = event.prev_events.filter(id=>(events[id].type !== 'missing'));
            event.auth_events = event.auth_events.filter(id=>(events[id].type !== 'missing'));
        }

        for (const parentId of event.prev_events.concat(event.auth_events)) {
            events[parentId].refs = events[parentId].refs ? (events[parentId].refs + 1) : 1;
        }
    }

    function shouldSkipParent(event) {
        if (event.prev_events.length == 1) {
            const parent = events[event.prev_events[0]];
            if (parent.prev_events.length == 1 && parent.refs == 1) {
                return true;
            }
        }
        return false;
    }

    const skipBoringParents = true;
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
    }

    // prune the events which were skipped
    for (const event of Object.values(events)) {
        if (event.skipped) delete events[event._event_id];
    }

    //console.log(JSON.stringify(events));

    const showAuthDag = false;
    let parentIdFn;
    if (showAuthDag) {
        parentIdFn = (event) => event.prev_events.concat(event.auth_events.filter(id=>id!=rootId));
    }
    else {
        parentIdFn = (event) => event.prev_events;
    }

    // stratify the events into a DAG
    const dag = d3dag.dagStratify()
        .id((event) => event._event_id)
        .linkData((target, source) => { return { auth: source.auth_events.includes(target._event_id) } })
        .parentIds(parentIdFn)(Object.values(events));

    const width = 2000;
    const height = 4000;

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

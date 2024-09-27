import * as d3 from 'd3';
import * as d3dag from 'd3-dag';

class Dag {
    constructor() {
        this.cache = Object.create(null);
        this.maxDepth = 0;
        this.latestEvents = {};
        this.earliestEvents = [];
        this.createEventId = null;
        this.stepInterval = 5;
        this.totalHopsBack = 5;
        this.showAuthChain = false;
        this.showPrevEvents = true;
        this.showOutliers = false;
        this.collapse = false;
    }
    async load(file) {
        const events = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (data) => {
                resolve(data.target.result.split("\n").filter((line => {
                    return line.trim().length > 0;
                })).map((line) => {
                    const j = JSON.parse(line);
                    if (j.event_id) {
                        j._event_id = j.event_id;
                    }
                    return j;
                }));
            };
            reader.readAsText(file);
        });
        let maxDepth = 0;
        events.forEach((ev) => {
            if (!ev) {
                throw new Error("missing event");
            }
            if (!ev._event_id) {
                throw new Error(`event is missing '_event_id', got ${JSON.stringify(ev)}`); 
            }
            if (!ev.type) {
                throw new Error(`event is missing 'type' field, got ${JSON.stringify(ev)}`);
            }
            if (!ev.depth) {
                throw new Error(`event is missing 'depth' field, got ${JSON.stringify(ev)}`);
            }
            this.cache[ev._event_id] = ev;
            if (ev.type === "m.room.create" && ev.state_key === "") {
                this.createEventId = ev._event_id;
                return;
            }
            if (ev.depth > maxDepth) {
                maxDepth = ev.depth;
                this.latestEvents = {}; // reset as we have an event with a deeper depth i.e newer
                this.latestEvents[ev._event_id] = ev;
            } else if (ev.depth === maxDepth) {
                this.latestEvents[ev._event_id] = ev;
            }
        });
        this.maxDepth = maxDepth;
    }
    setStepInterval(num) {
        this.stepInterval = num;
    }
    setShowAuthChain(show) {
        this.showAuthChain = show;
    }
    setShowPrevEvents(show) {
        this.showPrevEvents = show;
    }
    setShowOutliers(show) {
        this.showOutliers = show;
    }
    setCollapse(col) {
        this.collapse = col;
    }
    async refresh() {
        let renderEvents = await this.recalculate();
        if (this.collapse) {
            renderEvents = this.collapsifier(renderEvents);
        }
        await this.render(this.eventsToCompleteDag(renderEvents));
    }
    // returns the set of events to render
    async recalculate() {
        const renderEvents = Object.create(null);
        if (this.showPrevEvents) {
            const prevEvents = await this.loadEarlierEvents(this.latestEvents, "prev_events", this.totalHopsBack);
            for (const id in prevEvents.events) {
                renderEvents[id] = prevEvents.events[id];
            }
        }
        if (this.showAuthChain) {
            let createEventInChain = false;
            const authEvents = await this.loadEarlierEvents(this.latestEvents, "auth_events", this.totalHopsBack);
            for (const id in authEvents.events) {
                // we don't care about prev_events for auth chain so snip them if they aren't included yet
                const authEvent = authEvents.events[id];
                authEvent.prev_events = authEvent.prev_events.filter((pid) => {
                    return renderEvents[pid];
                })
                // We also don't care about the link to the create event as all events have this so it's just noise,
                // so snip it, but only if there are other refs (it's useful to see the chain at the beginning of the room)
                if (authEvent.auth_events.length > 1) {
                    authEvent.auth_events = authEvent.auth_events.filter((aid) => {
                        if (aid === this.createEventId) {
                            return false;
                        }
                        return true;
                    })
                } else if (authEvent.auth_events.length === 1 && authEvent.auth_events[0] === this.createEventId) {
                    createEventInChain = true;
                }
                renderEvents[id] = authEvent;
            }
            // we don't want the m.room.create event unless it is part of the dag, as it will be orphaned
            // due to not having auth events linking to it.
            if (!createEventInChain) {
                delete renderEvents[this.createEventId];
            }
        }
        return renderEvents;
    }

    // walk backwards from the `frontierEvents` (event_id -> Event JSON) given, using the `lookupKey` to find earlier events.
    // Stops when there is nowhere to go (create event) or when `hopsBack` has been reached.
    // Returns:
    // {
    //   events: {...} a map of event ID to event.
    //   frontiers: {...} the new frontier events (a map of event ID to event)
    // }
    async loadEarlierEvents(frontierEvents, lookupKey, hopsBack) {
        console.log("loadEarlierEvents", frontierEvents);
        let result = {}; // event_id -> Event JSON
        for (let i = 0; i < hopsBack; i++) {
            // walk the DAG backwards starting at the frontier entries.
            // look at either prev_events or auth_events (the lookup key)
            // and add them to the set of event IDs to find.
            const missingEventIds = new Set();
            for (const frontier of Object.values(frontierEvents)) {
                for (const earlierEventId of frontier[lookupKey]) {
                    if (!(earlierEventId in result)) {
                        missingEventIds.add(earlierEventId);
                    }
                }
            }
            if (missingEventIds.size === 0) {
                break;
            }
            // fetch the events from the in-memory cache which is the file
            const fetchedEventsById = Object.create(null);
            missingEventIds.forEach((id) => {
                if (this.cache[id]) {
                    fetchedEventsById[id] = this.cache[id];
                }
            });

            const fetchedEvents = Object.values(fetchedEventsById);
            if (fetchedEvents.length > 0) {
                // all frontier events get wiped so we can make forward progress and set new frontier events
                frontierEvents = {};
                for (const event of fetchedEvents) {
                    result[event._event_id] = event; // include this event
                    missingEventIds.delete(event._event_id);
                    // these events now become frontiers themselves
                    frontierEvents[event._event_id] = event;
                }
            }
        }
        return {
            events: result,
            frontiers: frontierEvents,
        };
    }

    // Converts a map of event ID to event into a complete DAG which d3dag will accept. This primarily
    // does 2 things:
    // - check prev/auth events and if they are missing in the dag AND the cache add a "missing" event
    // - check prev/auth events and if they are missing in the dag but not the cache add a "..." event.
    // Both these events have no prev/auth events so it forms a complete DAG with no missing nodes.
    eventsToCompleteDag(events) {
        for (let id in events) {
            const ev = events[id];
            const keys = ["auth_events", "prev_events"];
            keys.forEach((key) => {
                ev[key].forEach((id) => {
                    if (events[id]) {
                        return; // already linked to a renderable part of the dag, ignore.
                    }
                    if (this.cache[id]) {
                        events[id] = {
                            _event_id: id,
                            _backwards_extremity_key: key,
                            prev_events: [],
                            auth_events: [],
                            state_key: "...",
                            type: '...',
                        }
                    } else {
                        events[id] = {
                            _event_id: id,
                            prev_events: [],
                            auth_events: [],
                            state_key: "missing",
                            type: 'missing',
                        }
                    }
                });
            });
        }
        return events;
    }
    // find the event(s) which aren't pointed to by anyone which has prev/auth events, as this is the
    // forward extremity, we do this by playing a deathmatch - everyone is eligible at first and
    // then we loop all the prev/auth events and remove from the set until only the ones not being
    // pointed at exist.
    findForwardExtremities(events) {
        const s = new Set();
        for (const id in events) {
            s.add(id);
        }
        for (const id in events) {
            const ev = events[id];
            ev.prev_events.forEach((k) => {
                s.delete(k);
            });
            ev.auth_events.forEach((k) => {
                s.delete(k);
            });
        }
        return s;
    }

    // Removes events from this map for long linear sequences, instead replacing with a placeholder
    // "... N more ..." event. Forks are never replaced.
    collapsifier(events) {
        // take a copy of the events as we will be directly altering prev_events
        events = JSON.parse(JSON.stringify(events));
        const latestEvents = this.findForwardExtremities(events);

        // this algorithm works in two phases:
        // - figure out the "interesting" events (events which merge or create forks, fwd/backwards extremities)
        // - figure out the "keep list" which is the set of interesting events + 1 event padding for all interesting events
        //   we need the event padding so we can show forks sensibly, e.g consider:
        //      A   <-- keep as pointed to by >1 event
        //     / \
        //    B   C <-- these will be discarded as they have 1 prev_event and aren't a fwd extremity.
        //     \ /
        //      D   <-- keep as >1 prev_event
        //      |
        //      E   <-- keep as this is fwd extremity

        // work out the "interesting" events, which meet one of the criteria:
        // - Has 0 or 2+ prev_events (i.e not linear or is create/missing event)
        // - is a forward extremity
        // - is pointed to by >1 event (i.e "next_events")
        const interestingEvents = new Set();
        latestEvents.forEach((id) => {
            interestingEvents.add(id); // is a forward extremity
        });
        const pointCount = Object.create(null); // event ID -> num events pointing to it
        for (let evId in events) {
            const ev = events[evId];
            ev.prev_events.forEach((pe) => {
                let val = pointCount[pe] || 0;
                val += 1;
                pointCount[pe] = val;
            });
            if (ev.prev_events.length !== 1) {
                interestingEvents.add(ev._event_id); // Has 0 or 2+ prev_events (i.e not linear or is create/missing event)
            }
        }
        for (let id in pointCount) {
            if (pointCount[id] > 1) {
                interestingEvents.add(id); // is pointed to by >1 event (i.e "next_events")
            }
        }

        // make the keep list
        const keepList = new Set();
        for (let evId in events) {
            if (interestingEvents.has(evId)) {
                keepList.add(evId);
                continue;
            }
            // we might have this id in the keep list, if:
            // - THIS event points to an interesting event (C -> A in the example above)
            // - ANY interesting event points to THIS event (D -> C in the example above)
            const ev = events[evId];
            if (interestingEvents.has(ev.prev_events[0])) {
                keepList.add(evId);
                continue;
            }
            // slower O(n) loop
            for (let interestingId of interestingEvents) {
                const interestingEvent = events[interestingId];
                if (!interestingEvent) {
                    continue;
                }
                let added = false;
                for (let pe of interestingEvent.prev_events) {
                    if (pe === evId) {
                        keepList.add(evId);
                        added = true;
                        break;
                    }
                }
                if (added) {
                    break;
                }
            }
        }

        const queue = [];
        latestEvents.forEach((id) => {
            queue.push({
                id: id,
                from: id,
            });
        });

        while (queue.length > 0) {
            const data = queue.pop();
            const id = data.id;
            const ev = events[id];
            console.log(data.id, "prevs:", ev ? ev.prev_events : "null");
            if (!ev) {
                console.log("  no event");
                continue;
            }
            // continue walking..
            ev.prev_events.forEach((k) => {
                queue.push({
                    id: k,
                    from: data.id,
                });
            });

            if (keepList.has(id)) {
                console.log("  KEEP");
                continue;
            }

            // at this point we know this event is uninteresting, so remove ourselves and fix up the graph as we go
            delete events[id];
            const child = events[data.from];
            // console.log("Delete ", id, "new: ", child.prev_events, " -> ", ev.prev_events);
            const newPrevEvents = [ev.prev_events[0]];
            // the child may have interesting prev events, keep the ones in the keep list
            for (let pe in child.prev_events) {
                if (keepList.has(pe)) {
                    newPrevEvents.push(pe);
                }
            }
            child.prev_events = newPrevEvents;
            child._collapse = child._collapse || 0;
            child._collapse += 1;
            events[data.from] = child;
            console.log("  REMOVE: pointing " + data.from + " to " + ev.prev_events);
            // anything in the queue referencing this id needs to be repointed to reference the child
            queue.forEach((q) => {
                if (q.from === id) {
                    q.from = child._event_id;
                }
            });
        }
        return events;
    }

    // render a set of events
    async render(eventsToRender) {
        const hideOrphans = !this.showOutliers;
        document.getElementById("svgcontainer").innerHTML = "";
        const width = window.innerWidth;
        const height = window.innerHeight;
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
                if (this.showAuthChain) {
                    return event.prev_events.concat(event.auth_events.filter(id => id !== this.createEventId));
                } else {
                    return event.prev_events;
                }
            })(Object.values(eventsToRender));

        console.log(dag);

        if (hideOrphans) {
            if (dag.id === undefined) {
                // our root is an undefined placeholder, which means we have orphans
                dag.children = dag.children.filter(node => (node.children.length > 0));
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
            .attr('d', ({ data }) => line(data.points))
            .attr('fill', 'none')
            .attr('stroke-width', (d) => {
                const target = d.target;
                if (!target.data._collapse) {
                    return 3;
                }
                if (target.data._collapse < 5) {
                    return 5;
                }
                return 10;
            })
            .text("test")
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
            .attr('transform', ({ x, y }) => `translate(${x}, ${y})`);

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
            .text((d) => d.data._event_id.substr(0, 5) + " " + d.data.type)
            .attr('transform', `translate(${nodeRadius + 10}, 0)`)
            .attr('font-family', 'sans-serif')
            .attr('text-anchor', 'left')
            .attr('alignment-baseline', 'middle')
            .attr('fill', 'white')
            .attr('opacity', 0.7)
            .attr('stroke', 'white');

        nodes.append('text')
            .text((d) => {
                const id = d.data._event_id.substr(0, 5);
                const evType = d.data.type;
                const evStateKey = d.data.state_key ? "(" + d.data.state_key + ")" : "";
                const depth = d.data.depth ? d.data.depth : "";
                let collapse = d.data._collapse ? ("+" + d.data._collapse + " more") : "";
                if (collapse === "") {
                    if (d.data.origin !== undefined) {
                        collapse = d.data.origin; // TODO: nonstandard field?
                    }
                }
                return `${id} (${depth}) ${evType} ${evStateKey} ${collapse}`;
            })
            .attr('cursor', 'pointer')
            .on("click", async (d) => {
                if (d.data._backwards_extremity_key) {
                    // load more events
                    this.totalHopsBack += this.stepInterval;
                    this.refresh();
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

        d3.select('#svgcontainer').append(() => svgNode);
    }
};

window.onload = async (event) => {
    const dag = new Dag();
    document.getElementById("showauthevents").addEventListener("change", (ev) => {
        dag.setShowAuthChain(ev.target.checked);
        dag.refresh();
    });
    document.getElementById("showauthevents").checked = dag.showAuthChain;
    document.getElementById("showoutliers").addEventListener("change", (ev) => {
        dag.setShowOutliers(ev.target.checked);
        dag.refresh();
    });
    document.getElementById("showoutliers").checked = dag.showOutliers;
    document.getElementById("collapse").addEventListener("change", (ev) => {
        dag.setCollapse(ev.target.checked);
        dag.refresh();
    });
    document.getElementById("collapse").checked = dag.collapse;
    document.getElementById("step").addEventListener("change", (ev) => {
        dag.setStepInterval(Number(ev.target.value));
    });

    document.getElementById("go").addEventListener("click", async (ev) => {
        await dag.load(document.getElementById("jsonfile").files[0]);
        dag.refresh();
    });
    document.getElementById("closeinfocontainer").addEventListener("click", (ev) => {
        document.getElementById("infocontainer").style = "display: none;";
    })
    document.getElementById("infocontainer").style = "display: none;";
}

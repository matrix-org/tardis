import * as d3 from "d3";
import * as d3dag from "d3-dag";
import { type MatrixEvent, StateResolver, type DataGetEvent, StateResolverTransport } from "./state_resolver";

interface Link {
    auth: boolean;
}

class Dag {
    cache: Record<string, MatrixEvent>;
    maxDepth: number;
    latestEvents: Record<string, MatrixEvent>;
    createEventId: string | null;
    stepInterval: number;
    totalHopsBack: number;
    showAuthChain: boolean;
    showPrevEvents: boolean;
    showOutliers: boolean;
    collapse: boolean;
    startEventId: string;
    step: number;
    eventIdFileOrdering: string[];

    constructor() {
        this.cache = Object.create(null);
        this.maxDepth = 0;
        this.latestEvents = {};
        this.createEventId = null;
        this.stepInterval = 1;
        this.totalHopsBack = 1;
        this.showAuthChain = false;
        this.showPrevEvents = true;
        this.showOutliers = false;
        this.collapse = false;
        this.startEventId = "";
        this.step = 0;
        this.eventIdFileOrdering = [];
    }
    async load(file: File) {
        const events = await new Promise((resolve: (value: Array<MatrixEvent>) => void, reject) => {
            const reader = new FileReader();
            reader.onload = (data) => {
                if (!data.target || !data.target.result) {
                    return;
                }
                resolve(
                    (data.target.result as string)
                        .split("\n")
                        .filter((line) => {
                            return line.trim().length > 0;
                        })
                        .map((line) => {
                            const j = JSON.parse(line);
                            return j;
                        }),
                );
            };
            reader.readAsText(file);
        });
        let maxDepth = 0;
        for (const ev of events) {
            if (!ev) {
                throw new Error("missing event");
            }
            if (!ev.event_id) {
                throw new Error(`event is missing 'event_id', got ${JSON.stringify(ev)}`);
            }
            if (!ev.type) {
                throw new Error(`event is missing 'type' field, got ${JSON.stringify(ev)}`);
            }
            if (!ev.depth) {
                throw new Error(`event is missing 'depth' field, got ${JSON.stringify(ev)}`);
            }
            this.cache[ev.event_id] = ev;
            this.eventIdFileOrdering.push(ev.event_id);
            if (ev.type === "m.room.create" && ev.state_key === "") {
                this.createEventId = ev.event_id;
                continue;
            }
            if (ev.depth > maxDepth) {
                maxDepth = ev.depth;
                this.latestEvents = {}; // reset as we have an event with a deeper depth i.e newer
                this.latestEvents[ev.event_id] = ev;
            } else if (ev.depth === maxDepth) {
                this.latestEvents[ev.event_id] = ev;
            }
        }
        this.maxDepth = maxDepth;
    }
    setStepInterval(num: number) {
        this.stepInterval = num;
    }
    setShowAuthChain(show: boolean) {
        this.showAuthChain = show;
    }
    setShowPrevEvents(show: boolean) {
        this.showPrevEvents = show;
    }
    setShowOutliers(show: boolean) {
        this.showOutliers = show;
    }
    setCollapse(col: boolean) {
        this.collapse = col;
    }
    stepForward() {
        this.step = this.step + 1;
        if (this.step < 2) {
            this.step = 2; // need at least two nodes for d3-dag to draw stuff.
        }
        if (this.step > this.eventIdFileOrdering.length) {
            this.step = this.eventIdFileOrdering.length;
        }
    }
    stepBackward() {
        if (this.step > 0) {
            this.step -= 1;
        }
    }
    setStartEventId(eventId: string) {
        this.startEventId = eventId;
        if (this.cache[eventId]) {
            this.latestEvents = {
                eventId: this.cache[eventId],
            };
        }
    }
    async refresh() {
        let renderEvents = await this.recalculate();
        if (this.collapse) {
            renderEvents = this.collapsifier(renderEvents);
        }
        await this.render(this.eventsToCompleteDag(renderEvents));
    }
    // returns the set of events to render
    async recalculate(): Promise<Record<string, MatrixEvent>> {
        if (this.step > 0) {
            return this.recalculateStep();
        }
        return this.recalculateWalkBack();
    }

    async recalculateWalkBack(): Promise<Record<string, MatrixEvent>> {
        const renderEvents = Object.create(null);
        // always render the latest events
        for (const fwdExtremityId in this.latestEvents) {
            renderEvents[fwdExtremityId] = this.latestEvents[fwdExtremityId];
        }

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
                // Deep copy to avoid polluting the actual event.
                const authEvent = JSON.parse(JSON.stringify(authEvents.events[id]));
                authEvent.prev_events = authEvent.prev_events.filter((pid) => {
                    return renderEvents[pid];
                });
                // We also don't care about the link to the create event as all events have this so it's just noise,
                // so snip it, but only if there are other refs (it's useful to see the chain at the beginning of the room)
                if (authEvent.auth_events.length > 1) {
                    authEvent.auth_events = authEvent.auth_events.filter((aid) => {
                        if (aid === this.createEventId) {
                            return false;
                        }
                        return true;
                    });
                } else if (authEvent.auth_events.length === 1 && authEvent.auth_events[0] === this.createEventId) {
                    createEventInChain = true;
                }
                renderEvents[id] = authEvent;
            }
            // we don't want the m.room.create event unless it is part of the dag, as it will be orphaned
            // due to not having auth events linking to it.
            if (!createEventInChain && this.createEventId) {
                delete renderEvents[this.createEventId];
            }
        }
        return renderEvents;
    }

    // return the first N events in file ordering
    async recalculateStep(): Promise<Record<string, MatrixEvent>> {
        const renderEvents = Object.create(null);
        console.log("recalc step", this.eventIdFileOrdering, this.step, this.cache);
        for (let i = 0; i < this.step; i++) {
            const eventId = this.eventIdFileOrdering[i];
            if (!eventId) {
                // e.g out of bounds
                continue;
            }
            renderEvents[eventId] = this.cache[eventId];
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
    async loadEarlierEvents(frontierEvents: Record<string, MatrixEvent>, lookupKey: string, hopsBack: number) {
        console.log("loadEarlierEvents", frontierEvents);
        const result = {}; // event_id -> Event JSON
        for (let i = 0; i < hopsBack; i++) {
            // walk the DAG backwards starting at the frontier entries.
            // look at either prev_events or auth_events (the lookup key)
            // and add them to the set of event IDs to find.
            const missingEventIds = new Set<string>();
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
            const fetchedEventsById = Object.create(null) as Record<string, MatrixEvent>;
            for (const id of missingEventIds) {
                if (this.cache[id]) {
                    fetchedEventsById[id] = this.cache[id];
                }
            }

            const fetchedEvents = Object.values(fetchedEventsById);
            if (fetchedEvents.length > 0) {
                // all frontier events get wiped so we can make forward progress and set new frontier events
                // biome-ignore lint/style/noParameterAssign:
                frontierEvents = {} as Record<string, MatrixEvent>;
                for (const event of fetchedEvents) {
                    result[event.event_id] = event; // include this event
                    missingEventIds.delete(event.event_id);
                    // these events now become frontiers themselves
                    frontierEvents[event.event_id] = event;
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
    eventsToCompleteDag(events: Record<string, MatrixEvent>): Record<string, MatrixEvent> {
        for (const id in events) {
            const ev = events[id];
            const keys = ["auth_events", "prev_events"];
            for (const key of keys) {
                for (const id of ev[key]) {
                    if (events[id]) {
                        continue; // already linked to a renderable part of the dag, ignore.
                    }
                    if (this.cache[id]) {
                        events[id] = {
                            event_id: id,
                            _backwards_extremity_key: key,
                            prev_events: [],
                            auth_events: [],
                            state_key: "...",
                            type: "...",
                            content: {},
                            sender: "",
                            depth: 0,
                        };
                    } else {
                        events[id] = {
                            event_id: id,
                            prev_events: [],
                            auth_events: [],
                            state_key: "missing",
                            type: "missing",
                            content: {},
                            sender: "",
                            depth: 0,
                        };
                    }
                }
            }
        }
        return events;
    }
    // find the event(s) which aren't pointed to by anyone which has prev/auth events, as this is the
    // forward extremity, we do this by playing a deathmatch - everyone is eligible at first and
    // then we loop all the prev/auth events and remove from the set until only the ones not being
    // pointed at exist.
    findForwardExtremities(events): Set<string> {
        const s = new Set<string>();
        if (this.startEventId) {
            for (const id in events) {
                if (id === this.startEventId) {
                    s.add(id);
                    console.log(`returning start event ${id}`);
                    return s;
                }
            }
        }

        for (const id in events) {
            s.add(id);
        }
        for (const id in events) {
            const ev = events[id];
            for (const k of ev.prev_events) {
                s.delete(k);
            }
            for (const k of ev.auth_events) {
                s.delete(k);
            }
        }
        return s;
    }

    // Removes events from this map for long linear sequences, instead replacing with a placeholder
    // "... N more ..." event. Forks are never replaced.
    collapsifier(eventsOrig: Record<string, MatrixEvent>): Record<string, MatrixEvent> {
        // take a copy of the events as we will be directly altering prev_events
        const events = JSON.parse(JSON.stringify(eventsOrig)) as Record<string, MatrixEvent>;
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
        const interestingEvents = new Set<string>();
        for (const id of latestEvents) {
            interestingEvents.add(id); // is a forward extremity
        }
        const pointCount = Object.create(null); // event ID -> num events pointing to it
        for (const evId in events) {
            const ev = events[evId];
            for (const pe of ev.prev_events) {
                const val = pointCount[pe] || 0;
                pointCount[pe] = val + 1;
            }
            if (ev.prev_events.length !== 1) {
                interestingEvents.add(ev.event_id); // Has 0 or 2+ prev_events (i.e not linear or is create/missing event)
            }
        }
        for (const id in pointCount) {
            if (pointCount[id] > 1) {
                interestingEvents.add(id); // is pointed to by >1 event (i.e "next_events")
            }
        }

        // make the keep list
        const keepList = new Set();
        for (const evId in events) {
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
            for (const interestingId of interestingEvents) {
                const interestingEvent = events[interestingId];
                if (!interestingEvent) {
                    continue;
                }
                let added = false;
                for (const pe of interestingEvent.prev_events) {
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

        const queue = [] as Array<{ id: string; from: string }>;
        const seenQueue = new Set();
        for (const id of latestEvents) {
            queue.push({
                id: id,
                from: id,
            });
        }

        while (queue.length > 0) {
            const data = queue.pop();
            if (!data) {
                break;
            }
            const id = data.id;
            const ev = events[id];
            if (seenQueue.has(id)) {
                continue; // don't infinite loop
            }
            seenQueue.add(id);
            if (!ev) {
                console.log("  no event");
                continue;
            }
            // continue walking..
            for (const k of ev.prev_events) {
                queue.push({
                    id: k,
                    from: data.id,
                });
            }

            if (keepList.has(id)) {
                continue;
            }

            // at this point we know this event is uninteresting, so remove ourselves and fix up the graph as we go
            delete events[id];
            const child = events[data.from];
            // console.log("Delete ", id, "new: ", child.prev_events, " -> ", ev.prev_events);
            const newPrevEvents = [ev.prev_events[0]];
            // the child may have interesting prev events, keep the ones in the keep list
            for (const pe in child.prev_events) {
                if (keepList.has(pe)) {
                    newPrevEvents.push(pe);
                }
            }
            child.prev_events = newPrevEvents;
            child._collapse = child._collapse || 0;
            child._collapse += 1;
            events[data.from] = child;
            // anything in the queue referencing this id needs to be repointed to reference the child
            for (const q of queue) {
                if (q.from === id) {
                    q.from = child.event_id;
                }
            }
        }
        console.log("collapsifier complete");
        return events;
    }

    // render a set of events
    async render(eventsToRender: Record<string, MatrixEvent>) {
        const hideOrphans = !this.showOutliers;
        document.getElementById("svgcontainer")!.innerHTML = "";
        const width = window.innerWidth;
        const height = window.innerHeight;

        // stratify the events into a DAG
        console.log(eventsToRender);
        let dag = d3dag
            .dagStratify<MatrixEvent>()
            .id((event: MatrixEvent) => event.event_id)
            .parentIds((event: MatrixEvent) => {
                if (this.showAuthChain) {
                    return event.prev_events.concat(event.auth_events.filter((id) => id !== this.createEventId));
                }
                return event.prev_events;
            })
            .parentData((event: MatrixEvent): Array<[string, Link]> => {
                const parentData: Array<[string, Link]> = [];
                const parentEvents = this.showAuthChain
                    ? event.prev_events.concat(event.auth_events)
                    : event.prev_events;
                for (const parentEventId of new Set<string>(parentEvents)) {
                    const parentEvent = eventsToRender[parentEventId];
                    if (parentEvent) {
                        parentData.push([
                            parentEventId,
                            {
                                auth:
                                    event.auth_events.includes(parentEventId) && // the parent is an auth event
                                    !event.prev_events.includes(parentEventId), // the parent is not a prev_event (in which case prev_event wins in terms of colour)
                            },
                        ]);
                    }
                }
                return parentData;
            })(Object.values(eventsToRender));

        const rootNodes = dag.split();
        if (hideOrphans) {
            // hide root nodes with no children
            const connectedRoots = rootNodes.filter((dag) => {
                return dag.descendants().length > 1;
            });
            if (connectedRoots.length > 1) {
                console.error(
                    `hideOrphans: ${connectedRoots.length} roots with children, this should not be possible unless there are 2 DAG chunks in this file`,
                );
            }
            dag = connectedRoots[0];
        }

        console.log("dag:", dag);

        const nodeRadius = 10;
        const margin = nodeRadius * 4;
        const svgNode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgNode.setAttribute("width", String(width));
        svgNode.setAttribute("height", String(height));
        svgNode.setAttribute("viewBox", `${-margin} ${-margin} ${width + 10 * margin} ${height + 2 * margin}`);

        const svgSelection = d3.select(svgNode);
        const defs = svgSelection.append("defs");

        // below is derived from
        // https://observablehq.com/@erikbrinkman/d3-dag-sugiyama-with-arrows

        // d3dag.zherebko()
        d3dag
            .sugiyama()
            .layering(d3dag.layeringCoffmanGraham().width(2))
            .coord(d3dag.coordGreedy())
            .size([width, height])(dag);

        const steps = dag.size();
        const interp = d3.interpolateRainbow;
        const colorMap = {};
        dag.idescendants("after").forEach((node, i) => {
            colorMap[node.id] = interp(i / steps);
        });

        // How to draw edges
        const line = d3
            .line()
            .curve(d3.curveCatmullRom)
            .x((d) => d.x)
            .y((d) => d.y);

        // Plot edges
        const edges = svgSelection
            .append("g")
            .selectAll("path")
            .data(dag.links())
            .enter()
            //.filter(({data})=>!data.auth)
            .append("path")
            .attr("d", ({ points }) => line(points))
            .attr("fill", "none")
            .attr("stroke-width", (d) => {
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
            .attr("stroke", (dagLink) => {
                const source = dagLink.source;
                const target = dagLink.target;

                const gradId = `${source.id}-${target.id}`;
                const grad = defs
                    .append("linearGradient")
                    .attr("id", gradId)
                    .attr("gradientUnits", "userSpaceOnUse")
                    .attr("x1", source.x)
                    .attr("x2", target.x)
                    .attr("y1", source.y)
                    .attr("y2", target.y);

                /*
                grad.append('stop')
                    .attr('offset', '0%').attr('stop-color', colorMap[source.id]);
                grad.append('stop')
                    .attr('offset', '100%').attr('stop-color', colorMap[target.id]); */
                grad.append("stop")
                    .attr("offset", "0%")
                    .attr("stop-color", dagLink.data.auth ? colorMap[source.id] : "#000");
                grad.append("stop")
                    .attr("offset", "100%")
                    .attr("stop-color", dagLink.data.auth ? colorMap[target.id] : "#000");
                return `url(#${gradId})`;
            });

        // Select nodes
        const nodes = svgSelection
            .append("g")
            .selectAll("g")
            .data(dag.descendants())
            .enter()
            .append("g")
            .attr("transform", ({ x, y }) => `translate(${x}, ${y})`);

        // Plot node circles
        nodes
            .append("circle")
            .attr("r", nodeRadius)
            .attr("fill", (n) => colorMap[n.id]);

        // Add text to nodes with border
        const getLabel = (d) => {
            const id = d.data.event_id.substr(0, 5);
            const evType = d.data.type;
            const evStateKey = d.data.state_key ? `(${d.data.state_key})` : "";
            const depth = d.data.depth ? d.data.depth : "";
            let collapse = d.data._collapse ? `+${d.data._collapse} more` : "";
            if (collapse === "") {
                if (d.data.origin !== undefined) {
                    collapse = d.data.origin; // TODO: nonstandard field?
                }
            }
            const text = `${id} (${depth}) ${evType} ${evStateKey} ${collapse}`;
            if (d.data._backwards_extremity_key) {
                return "load more";
            }
            return text;
        };
        nodes
            .append("text")
            .text((d) => {
                return getLabel(d);
            })
            .attr("transform", `translate(${nodeRadius + 10}, 0)`)
            .attr("font-family", "sans-serif")
            .attr("text-anchor", "left")
            .attr("alignment-baseline", "middle")
            .attr("fill", "white")
            .attr("opacity", 0.8)
            .attr("stroke", "white");

        nodes
            .append("text")
            .text((d) => {
                return getLabel(d);
            })
            .attr("cursor", "pointer")
            .on("click", async (event, d) => {
                if (d.data._backwards_extremity_key) {
                    // load more events
                    this.totalHopsBack += this.stepInterval;
                    this.refresh();
                    return;
                }
                document.getElementById("eventdetails")!.textContent = JSON.stringify(d.data, null, 2);
                document.getElementById("infocontainer")!.style.display = "block";
            })
            .attr("transform", `translate(${nodeRadius + 10}, 0)`)
            .attr("font-family", "sans-serif")
            .attr("text-anchor", "left")
            .attr("alignment-baseline", "middle")
            .attr("fill", (d) => {
                if (d.data._backwards_extremity_key) {
                    return "red";
                }
                return "black";
            });

        function zoomed({ transform }) {
            nodes.attr("transform", (d) => {
                return `translate(${transform.applyX(d.x)}, ${transform.applyY(d.y)})`;
            });

            edges.attr("d", ({ points }) =>
                line(points.map((d) => ({ x: transform.applyX(d.x), y: transform.applyY(d.y) }))),
            );
        }

        const zoom = d3.zoom().scaleExtent([0.1, 10]).on("zoom", zoomed);

        svgSelection.call(zoom).call(zoom.transform, d3.zoomIdentity);
        d3.select("#svgcontainer").append(() => svgNode);
    }
}
let dag = new Dag();

const transport = new StateResolverTransport("http://localhost:1234");
const resolver = new StateResolver(transport, (data: DataGetEvent): MatrixEvent => {
    return dag.cache[data.event_id];
});
try {
    transport.connect(resolver);
} catch (err) {
    console.error("failed to setup WS connection:", err);
}

document.getElementById("showauthevents")!.addEventListener("change", (ev) => {
    dag.setShowAuthChain((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
(<HTMLInputElement>document.getElementById("showauthevents"))!.checked = dag.showAuthChain;
document.getElementById("showoutliers")!.addEventListener("change", (ev) => {
    dag.setShowOutliers((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
(<HTMLInputElement>document.getElementById("showoutliers"))!.checked = dag.showOutliers;
document.getElementById("collapse")!.addEventListener("change", (ev) => {
    dag.setCollapse((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
(<HTMLInputElement>document.getElementById("collapse"))!.checked = dag.collapse;
document.getElementById("step")!.addEventListener("change", (ev) => {
    dag.setStepInterval(Number((<HTMLInputElement>ev.target)!.value));
});
document.getElementById("start")!.addEventListener("change", (ev) => {
    dag.setStartEventId((<HTMLInputElement>ev.target)!.value);
    dag.refresh();
});

(<HTMLInputElement>document.getElementById("jsonfile")).addEventListener(
    "change",
    async (ev) => {
        const files = (<HTMLInputElement>document.getElementById("jsonfile")).files;
        if (!files) {
            return;
        }
        dag = new Dag();
        await dag.load(files[0]);
    },
    false,
);

document.getElementById("go")!.addEventListener("click", async (ev) => {
    dag.refresh();
});
document.getElementById("closeinfocontainer")!.addEventListener("click", (ev) => {
    document.getElementById("infocontainer")!.style.display = "none";
});
document.getElementById("infocontainer")!.style.display = "none";

document.getElementById("stepfwd")!.addEventListener("click", async (ev) => {
    dag.stepForward();
    dag.refresh();
});
document.getElementById("stepbwd")!.addEventListener("click", async (ev) => {
    dag.stepBackward();
    dag.refresh();
});

import * as d3 from "d3";
import * as d3dag from "d3-dag";
import { Cache } from "./cache";
import { Debugger } from "./debugger";
import { EventList } from "./event_list";
import { redraw } from "./graph";
import { mainlineForks, quickstartFile, reverseTopologicalPowerOrdering } from "./preloaded_scenarios";
import { type Scenario, type ScenarioFile, loadScenarioFromFile, loadScenarioFromScenarioFile } from "./scenario";
import {
    type DataGetEvent,
    type EventID,
    type MatrixEvent,
    type StateKeyTuple,
    StateResolver,
    StateResolverTransport,
} from "./state_resolver";

const preloadedScenarios: Record<string, ScenarioFile> = {
    "Quick Start": quickstartFile,
    "Mainline Ordering": mainlineForks,
    "Reverse Topological Power Ordering": reverseTopologicalPowerOrdering,
};

interface Link {
    auth: boolean;
}

const eventList = new EventList(
    document.getElementById("eventlist")!,
    document.getElementById("eventlisttemplate") as HTMLTemplateElement,
);

class Dag {
    cache: Cache;
    createEventId: string | null;
    showAuthChain: boolean;
    showPrevEvents: boolean;
    showOutliers: boolean;
    showTimestamps: boolean;
    collapse: boolean;
    experimentalLayout: boolean;
    shimUrl?: string;

    debugger: Debugger;

    renderEvents: Record<string, MatrixEvent>;
    scenario?: Scenario;

    constructor(cache: Cache) {
        this.cache = cache;
        this.createEventId = null;
        this.showAuthChain = false;
        this.showPrevEvents = true;
        this.showOutliers = false;
        this.showTimestamps = false;
        this.collapse = false;
        this.experimentalLayout = false;
        this.renderEvents = {};
    }

    setShimUrl(u: string) {
        this.shimUrl = u;
        console.log("setShimUrl", u);
    }

    async loadFile(file: File) {
        const scenario = await loadScenarioFromFile(file);
        this.loadScenario(scenario);
    }

    loadScenario(scenario: Scenario) {
        for (const ev of scenario.events) {
            this.cache.eventCache.store(ev);
            if (ev.type === "m.room.create" && ev.state_key === "") {
                this.createEventId = ev.event_id;
            }
        }
        if (scenario.precalculatedStateAfter) {
            for (const preCalcEventId in scenario.precalculatedStateAfter) {
                const stateMap: Record<StateKeyTuple, EventID> = {};
                for (const stateEventId of scenario.precalculatedStateAfter[preCalcEventId]) {
                    const stateEvent = this.cache.eventCache.get(stateEventId);
                    if (!stateEvent || stateEvent.state_key == null) {
                        console.log(
                            `precalculated_state_after for ${preCalcEventId} includes ${stateEventId} but it isn't a state event we know about. Skipping.`,
                        );
                        continue;
                    }
                    stateMap[JSON.stringify([stateEvent.type, stateEvent.state_key])] = stateEvent.event_id;
                }
                this.cache.stateAtEvent.setState(preCalcEventId, stateMap);
            }
        }
        this.scenario = scenario;
        this.debugger = new Debugger(scenario);
        if (scenario.onLoadAtStart && scenario.events.length >= 2) {
            this.debugger.goTo(scenario.events[1].event_id);
        }
        eventList.clear();
        scenario.events.forEach((ev, i) => {
            eventList.appendEvent(i, ev);
        });
        eventList.highlight(this.debugger.current());
        eventList.onEventClick((eventId: string) => {
            this.debugger.goTo(eventId);
            this.refresh();
            eventList.highlight(dag.debugger.current());
        });
        eventList.onEventJsonClick((eventId: string) => {
            document.getElementById("eventdetails")!.textContent = JSON.stringify(
                this.cache.eventCache.get(eventId),
                null,
                2,
            );
            document.getElementById("infocontainer")!.style.display = "block";
        });
        this.refresh();
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
    setTimestamps(ts: boolean) {
        this.showTimestamps = ts;
    }
    setExperimentalLayout(exp: boolean) {
        this.experimentalLayout = exp;
        if (this.experimentalLayout) {
            document.getElementById("svgcontainer")?.classList.add("monospace");
        } else {
            document.getElementById("svgcontainer")?.classList.remove("monospace");
        }
    }
    async refresh() {
        let renderEvents = await this.recalculate();
        if (this.experimentalLayout) {
            const eventsArray: Array<MatrixEvent> = [];
            for (const k in renderEvents) {
                eventsArray.push(renderEvents[k]);
            }
            redraw(document.getElementById("svgcontainer")! as HTMLDivElement, eventsArray);
            return;
        }

        if (this.collapse) {
            renderEvents = this.collapsifier(renderEvents);
        }
        this.renderEvents = renderEvents;
        await this.render(this.eventsToCompleteDag(renderEvents));
    }
    // returns the set of events to render
    async recalculate(): Promise<Record<string, MatrixEvent>> {
        const renderEvents = Object.create(null);
        for (const eventId of this.debugger.eventsUpToCurrent()) {
            renderEvents[eventId] = this.cache.eventCache.get(eventId);
        }
        return renderEvents;
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
                    if (this.cache.eventCache.get(id)) {
                        events[id] = {
                            event_id: id,
                            prev_events: [],
                            auth_events: [],
                            state_key: "...",
                            type: "...",
                            content: {},
                            sender: "",
                            room_id: "!",
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
                            room_id: "!",
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
        const svgContainer = document.getElementById("svgcontainer")!;
        svgContainer.innerHTML = "";
        const width = svgContainer.offsetWidth;
        const height = window.innerHeight;

        // stratify the events into a DAG
        console.log(eventsToRender);
        if (Object.keys(eventsToRender).length <= 1) {
            return; // we need at least 2 nodes for d3-dag to render things.
        }
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
        const title = svgSelection
            .append("text")
            .attr("x", width / 3)
            .attr("y", -40)
            .style("font-size", "24px");
        // use the title for the current event
        let currTitle = this.scenario?.annotations?.titles?.[this.debugger.current()];
        if (!currTitle) {
            // ...fallback to the global title or nothing
            currTitle = this.scenario?.annotations?.title || "";
        }
        for (const titleLine of currTitle.split("\n")) {
            title
                .append("tspan")
                .attr("x", width / 2)
                .attr("dy", "1.2em")
                .text(titleLine);
        }
        const defs = svgSelection.append("defs");

        // below is derived from
        // https://observablehq.com/@erikbrinkman/d3-dag-sugiyama-with-arrows

        // d3dag.zherebko()
        d3dag
            .sugiyama()
            .layering(d3dag.layeringCoffmanGraham().width(2))
            .coord(d3dag.coordCenter())
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
        const stateEvents = this.cache.stateAtEvent.getStateAsEventIds(this.debugger.current());
        nodes
            .append("circle")
            .attr("r", (n) => {
                const ev = this.cache.eventCache.get(n.id);
                if (ev && ev.state_key != null) {
                    return nodeRadius * 1.5;
                }
                return nodeRadius;
            })
            .attr("fill", (n) => {
                if (n.id === this.debugger.current()) {
                    return "blue";
                }
                if (stateEvents.has(n.id)) {
                    return "green";
                }
                return "black";
            });

        // Add text to nodes with border
        const getLabel = (d) => {
            const eventId = d.data.event_id;
            const id = eventId.substr(0, 5);
            if (this.scenario?.annotations?.events?.[eventId]) {
                return `${id} ${this.scenario?.annotations?.events[eventId]}`;
            }
            const text = eventList.textRepresentation(d.data);
            const depth = d.data.depth ? `(${d.data.depth})` : "";
            let collapse = d.data._collapse ? `+${d.data._collapse} more` : "";
            if (collapse === "") {
                if (d.data.origin !== undefined) {
                    collapse = d.data.origin; // TODO: nonstandard field?
                }
            }
            return `${id} ${depth} ${text} ${collapse}`;
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
                this.debugger.goTo(d.data.event_id);
                eventList.highlight(d.data.event_id);
                this.refresh();
            })
            .attr("transform", `translate(${nodeRadius + 10}, 0)`)
            .attr("font-family", "sans-serif")
            .attr("text-anchor", "left")
            .attr("alignment-baseline", "middle")
            .attr("fill", (d) => {
                return "black";
            });

        // add timestamps
        if (this.showTimestamps) {
            nodes
                .append("text")
                .text((d) => {
                    const date = new Date(d.data.origin_server_ts || 0);
                    return date.toLocaleString();
                })
                .attr("transform", `translate(${nodeRadius + 10}, ${nodeRadius + 10})`)
                .attr("font-family", "sans-serif")
                .attr("text-anchor", "left")
                .attr("alignment-baseline", "middle")
                .attr("fill", (d) => {
                    return "grey";
                });
        }

        function zoomed({ transform }) {
            nodes.attr("transform", (d) => {
                return `translate(${transform.applyX(d.x)}, ${transform.applyY(d.y)})`;
            });
            edges.attr("d", ({ points }) =>
                line(points.map((d) => ({ x: transform.applyX(d.x), y: transform.applyY(d.y) }))),
            );
            title.attr("transform", () => {
                return `translate(${transform.applyX(title.attr("x"))}, ${transform.applyY(title.attr("y"))})`;
            });
        }

        const zoom = d3.zoom().scaleExtent([0.1, 10]).on("zoom", zoomed);

        svgSelection.call(zoom).call(zoom.transform, d3.zoomIdentity);
        d3.select("#svgcontainer").append(() => svgNode);
    }
}
let dag = new Dag(new Cache());
dag.setShimUrl(document.getElementById("shimurl").value); // TODO: this is annoying in so many places..
const transport = new StateResolverTransport();
const resolver = new StateResolver(transport, (data: DataGetEvent): MatrixEvent => {
    return dag.cache.eventCache.get(data.event_id)!;
});

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
(<HTMLInputElement>document.getElementById("timestamps"))!.checked = dag.showTimestamps;
document.getElementById("timestamps")!.addEventListener("change", (ev) => {
    dag.setTimestamps((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
document.getElementById("explayout")!.addEventListener("change", (ev) => {
    dag.setExperimentalLayout((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
(<HTMLInputElement>document.getElementById("collapse"))!.checked = dag.collapse;
(<HTMLInputElement>document.getElementById("jsonfile")).addEventListener(
    "change",
    async (ev) => {
        const files = (<HTMLInputElement>document.getElementById("jsonfile")).files;
        if (!files) {
            return;
        }
        dag = new Dag(new Cache());
        // set it initially from the input value else we might resolve without ever calling setShimUrl
        dag.setShimUrl(document.getElementById("shimurl").value);
        await dag.loadFile(files[0]);
    },
    false,
);

document.getElementById("closeinfocontainer")!.addEventListener("click", (ev) => {
    document.getElementById("infocontainer")!.style.display = "none";
});
document.getElementById("infocontainer")!.style.display = "none";

document.getElementById("stepfwd")!.addEventListener("click", async (ev) => {
    dag.debugger.next();
    dag.refresh();
    eventList.highlight(dag.debugger.current());
});
document.getElementById("stepbwd")!.addEventListener("click", async (ev) => {
    dag.debugger.previous();
    dag.refresh();
    eventList.highlight(dag.debugger.current());
});

document.getElementById("shimurl")!.addEventListener("change", (ev) => {
    const newUrl = (<HTMLInputElement>ev.target)!.value;
    dag.setShimUrl(newUrl);
    globalThis.localStorage.setItem("shim_url", newUrl);
});
// set placeholder from local storage
const existingShimUrl = globalThis.localStorage.getItem("shim_url");
if (existingShimUrl) {
    console.log("setting shim url from local storage");
    document.getElementById("shimurl")!.value = existingShimUrl;
}

document.getElementById("resolve")!.addEventListener("click", async (ev) => {
    await dag.debugger.resolve(
        dag.cache,
        async (
            roomId: string,
            roomVer: string,
            states: Array<Record<StateKeyTuple, EventID>>,
        ): Promise<Record<StateKeyTuple, EventID>> => {
            if (!dag.shimUrl) {
                console.error("you need to set a shim url to resolve state!");
                return {};
            }
            try {
                await transport.connect(dag.shimUrl, resolver);
                const r = await resolver.resolveState(roomId, roomVer, states);
                return r.state;
            } catch (err) {
                console.error("failed to setup WS connection:", err);
            } finally {
                transport.close();
            }
            return {};
        },
    );
    dag.refresh();
});

// pull in GMSL bits
const go = new Go(); // Defined in wasm_exec.js
WebAssembly.instantiateStreaming(fetch("gmsl.wasm"), go.importObject).then((obj) => {
    globalThis.wasm = obj.instance;
    go.run(globalThis.wasm);

    const loadPreloadedFile = (sf: ScenarioFile) => {
        // now load the tutorial scenario
        const tutorial = loadScenarioFromScenarioFile(sf);
        dag.loadScenario(tutorial);
    };

    const select = document.getElementById("file-select");
    if (select) {
        select.innerHTML = "";
        Object.keys(preloadedScenarios).forEach((val, index) => {
            select[index] = new Option(val);
        });
        select.addEventListener("change", (event) => {
            const sf = preloadedScenarios[event?.target?.value];
            loadPreloadedFile(sf);
        });
    }
    loadPreloadedFile(quickstartFile);
});

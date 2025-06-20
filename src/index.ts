import hljs from "highlight.js/lib/core";
import hljsjson from "highlight.js/lib/languages/json";
import { printAuthDagAnalysis } from "./auth_dag";
import { fromURLSafeBase64, toURLSafeBase64 } from "./base64";
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

hljs.registerLanguage("json", hljsjson);

declare global {
    var wasm: WebAssembly.Instance;
    // from wasm_exec.js
    class Go {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        run(thing: any): Promise<void>;
        importObject: WebAssembly.Imports;
    }
}

const preloadedScenarios: Record<string, ScenarioFile> = {
    "Quick Start": quickstartFile,
    "Mainline Ordering": mainlineForks,
    "Reverse Topological Power Ordering": reverseTopologicalPowerOrdering,
};

const eventList = new EventList(
    document.getElementById("eventlist")!,
    document.getElementById("eventlisttemplate") as HTMLTemplateElement,
);

class Dag {
    cache: Cache;
    createEventId: string | null;
    showAuthChain: boolean;
    showAuthDAG: boolean;
    showOutliers: boolean;
    showStateSets: boolean;
    collapse: boolean;
    shimUrl?: string;

    debugger: Debugger;

    renderEvents: Record<string, MatrixEvent>;
    scenario?: Scenario;
    scenarioFile?: ScenarioFile | null;

    constructor(cache: Cache) {
        this.cache = cache;
        this.createEventId = null;
        this.showAuthChain = false;
        this.showAuthDAG = false;
        this.showOutliers = false;
        this.showStateSets = false;
        this.collapse = false;
        this.renderEvents = {};
        this.scenarioFile = null;
    }

    setShimUrl(u: string) {
        this.shimUrl = u;
        console.log("setShimUrl", u);
    }

    async loadFile(file: File) {
        const scenarioFile = await loadScenarioFromFile(file);
        this.loadScenarioFile(scenarioFile);
    }

    loadScenarioFile(scenarioFile: ScenarioFile) {
        this.scenarioFile = JSON.parse(JSON.stringify(scenarioFile));
        const scenario = loadScenarioFromScenarioFile(scenarioFile);
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
        let hasAuthDAGEvents = false;
        scenario.events.forEach((ev, i) => {
            eventList.appendEvent(i, ev);
            if (ev.prev_auth_events && ev.prev_auth_events.length > 0) {
                hasAuthDAGEvents = true;
            }
        });
        eventList.highlight(this.debugger.current());
        eventList.onEventClick((eventId: string) => {
            this.debugger.goTo(eventId);
            this.refresh();
            eventList.highlight(dag.debugger.current());
        });
        eventList.onEventJsonClick((eventId: string) => {
            const highlightedCode = hljs.highlight(JSON.stringify(this.cache.eventCache.get(eventId), null, 2), {
                language: "json",
            });
            document.getElementById("eventdetails")!.innerHTML = highlightedCode.value;
            document.getElementById("infocontainer")!.style.display = "block";
        });
        if (hasAuthDAGEvents) {
            printAuthDagAnalysis(scenario);
        }
        this.refresh();
    }
    setShowAuthChain(show: boolean) {
        this.showAuthChain = show;
    }
    setShowAuthDAG(show: boolean) {
        this.showAuthDAG = show;
    }
    setShowOutliers(show: boolean) {
        this.showOutliers = show;
    }
    setShowStateSets(show: boolean) {
        this.showStateSets = show;
    }
    setCollapse(col: boolean) {
        this.collapse = col;
    }
    async refresh() {
        let renderEvents = Object.create(null);
        for (const eventId of this.debugger.eventsUpToCurrent()) {
            renderEvents[eventId] = this.cache.eventCache.get(eventId);
        }
        if (this.collapse) {
            renderEvents = this.collapsifier(renderEvents);
        }
        const eventsArray: Array<MatrixEvent> = [];
        for (const k in renderEvents) {
            eventsArray.push(renderEvents[k]);
        }
        let inverseStateSets: Record<EventID, Set<EventID>> = {};
        const currentEvent = this.cache.eventCache.get(this.debugger.current());
        if (currentEvent) {
            inverseStateSets = this.cache.stateAtEvent.getInverseStateForEventIds(
                new Set<EventID>(currentEvent.prev_events),
            );
        }
        redraw(document.getElementById("svgcontainer")! as HTMLDivElement, eventsArray, {
            currentEventId: this.debugger.current(),
            scenario: this.scenario,
            stateAtEvent: this.cache.stateAtEvent.getStateAsEventIds(this.debugger.current()),
            inverseStateSets: inverseStateSets,
            showAuthChain: this.showAuthChain,
            showAuthDAG: this.showAuthDAG,
            showStateSets: this.showStateSets,
        });
    }
    // find the event(s) which aren't pointed to by anyone which has prev/auth events, as this is the
    // forward extremity, we do this by playing a deathmatch - everyone is eligible at first and
    // then we loop all the prev/auth events and remove from the set until only the ones not being
    // pointed at exist.
    findForwardExtremities(events: Record<string, MatrixEvent>): Set<string> {
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
}
const shimInputElement = document.getElementById("shimurl") as HTMLInputElement;
let dag = new Dag(new Cache());
dag.setShimUrl(shimInputElement.value); // TODO: this is annoying in so many places..
const transport = new StateResolverTransport();
const resolver = new StateResolver(transport, (data: DataGetEvent): MatrixEvent => {
    return dag.cache.eventCache.get(data.event_id)!;
});

document.getElementById("showauthevents")!.addEventListener("change", (ev) => {
    dag.setShowAuthChain((<HTMLInputElement>ev.target)!.checked);
    if ((<HTMLInputElement>ev.target)!.checked) {
        dag.setShowAuthDAG(false);
    }
    dag.refresh();
    (<HTMLInputElement>document.getElementById("showauthevents"))!.checked = dag.showAuthChain;
    (<HTMLInputElement>document.getElementById("showauthdag"))!.checked = dag.showAuthDAG;
});

document.getElementById("showauthdag")!.addEventListener("change", (ev) => {
    dag.setShowAuthDAG((<HTMLInputElement>ev.target)!.checked);
    if ((<HTMLInputElement>ev.target)!.checked) {
        dag.setShowAuthChain(false);
    }
    dag.refresh();
    (<HTMLInputElement>document.getElementById("showauthevents"))!.checked = dag.showAuthChain;
    (<HTMLInputElement>document.getElementById("showauthdag"))!.checked = dag.showAuthDAG;
});

document.getElementById("showstatesets")!.addEventListener("change", (ev) => {
    dag.setShowStateSets((<HTMLInputElement>ev.target)!.checked);
    dag.refresh();
});
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
(<HTMLInputElement>document.getElementById("jsonfile")).addEventListener(
    "change",
    async (_) => {
        const files = (<HTMLInputElement>document.getElementById("jsonfile")).files;
        if (!files) {
            return;
        }
        dag = new Dag(new Cache());
        // set it initially from the input value else we might resolve without ever calling setShimUrl
        dag.setShimUrl(shimInputElement.value);
        await dag.loadFile(files[0]);
    },
    false,
);

document.getElementById("infocontainer")!.style.display = "none";

document.addEventListener("click", (event) => {
    const popup = document.getElementById("infocontainer")!;
    if (!popup.contains(event.target as Node)) {
        popup.style.display = "none";
    }
});

document.getElementById("stepfwd")!.addEventListener("click", async (_) => {
    dag.debugger.next();
    dag.refresh();
    eventList.highlight(dag.debugger.current());
});
document.getElementById("stepbwd")!.addEventListener("click", async (_) => {
    dag.debugger.previous();
    dag.refresh();
    eventList.highlight(dag.debugger.current());
});

shimInputElement.addEventListener("change", (ev) => {
    const newUrl = (<HTMLInputElement>ev.target)!.value;
    dag.setShimUrl(newUrl);
    globalThis.localStorage.setItem("shim_url", newUrl);
});
// set placeholder from local storage
const existingShimUrl = globalThis.localStorage.getItem("shim_url");
if (existingShimUrl) {
    console.log("setting shim url from local storage");
    shimInputElement.value = existingShimUrl;
    dag.setShimUrl(existingShimUrl);
}

const loaderElement = document.getElementById("loader")!;
const loaderMsgElement = document.getElementById("loader-status")!;

const setLoaderMessage = (text: string) => {
    loaderMsgElement.innerText = text;
};

document.getElementById("resolve")!.addEventListener("click", async (_) => {
    if (!dag.shimUrl) {
        console.error("you need to set a shim url to resolve state!");
        return {};
    }
    loaderElement.style.display = "block";
    setLoaderMessage(`Connecting to ${dag.shimUrl}`);
    try {
        await transport.connect(dag.shimUrl, resolver);
        await dag.debugger.resolve(
            dag.cache,
            async (
                roomId: string,
                roomVer: string,
                states: Array<Record<StateKeyTuple, EventID>>,
                atEvent: MatrixEvent,
            ): Promise<Record<StateKeyTuple, EventID>> => {
                try {
                    setLoaderMessage(`Resolving state at event ${atEvent.event_id}`);
                    const r = await resolver.resolveState(roomId, roomVer, states, atEvent);
                    return r.state;
                } catch (err) {
                    console.error("failed to resolve state:", err);
                    setLoaderMessage(`Failed to resolve state at event ${atEvent.event_id} : ${err}`);
                    throw err;
                }
            },
        );
        setLoaderMessage("");
    } catch (err) {
        console.error("resolving state failed: ", err);
    } finally {
        transport.close();
    }
    loaderElement.style.display = "none";
    dag.refresh();
});

document.getElementById("share")?.addEventListener("click", async (_) => {
    try {
        if (!dag.scenarioFile) {
            throw new Error("no loaded file");
        }
        const fragment = toURLSafeBase64(dag.scenarioFile);
        const urlWithoutFragment = window.location.href.split("#")[0];
        await navigator.clipboard.writeText(`${urlWithoutFragment}#${fragment}`);
        setLoaderMessage("Share link copied to clipboard");
    } catch (err) {
        setLoaderMessage(`Unable to copy to clipboard: ${err}`);
    }
});

document.getElementById("save")?.addEventListener("click", async (_) => {
    if (!dag.scenarioFile) {
        setLoaderMessage("No loaded scenario");
        return;
    }
    const blob = new Blob([JSON.stringify(dag.scenarioFile, null, 4)], { type: "text/plain" });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scenario.json5";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url); // clean up
});

// pull in GMSL bits
const go = new Go();
WebAssembly.instantiateStreaming(fetch("gmsl.wasm"), go.importObject).then((obj) => {
    globalThis.wasm = obj.instance;
    go.run(globalThis.wasm);

    const loadPreloadedFile = (sf: ScenarioFile) => {
        // now load the tutorial scenario
        dag.loadScenarioFile(sf);
    };

    const select = document.getElementById("file-select") as HTMLSelectElement;
    if (select) {
        select.innerHTML = "";
        Object.keys(preloadedScenarios).forEach((val, index) => {
            select[index] = new Option(val);
        });
        select.addEventListener("change", (event) => {
            const sf = preloadedScenarios[(event?.target as HTMLSelectElement)?.value];
            loadPreloadedFile(sf);
        });
    }
    if (globalThis.location.hash.length > 1) {
        // we may have an inline scenario, so use that if we can.
        try {
            const possibleScenario = fromURLSafeBase64(globalThis.location.hash.substring(1)) as ScenarioFile;
            loadPreloadedFile(possibleScenario);
            return;
        } catch (err) {
            console.error("failed to read fragment: ", err);
        }
    }
    // console.log(toURLSafeBase64(reverseTopologicalPowerOrdering));
    loadPreloadedFile(quickstartFile);
});

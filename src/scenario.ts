import JSON5 from "json5";
import type { EventID, MatrixEvent } from "./state_resolver";

export const DEFAULT_ROOM_VERSION = "10";

// ScenarioFile is the file format of .json5 files used with tardis.
export interface ScenarioFile {
    // Required. The version of the file, always '1'.
    tardis_version: number;
    // Required. The events in this scenario, in the order they should be processed (typically topologically sorted)
    events: Array<ScenarioEvent>;
    // Optional. The room version these events are represented in. Default: DEFAULT_ROOM_VERSION.
    room_version: string;
    // Optional. If events are missing a room_id key, populate it from this field. For brevity.
    room_id: string;
    // Optional. If true, calculates the event_id field.
    calculate_event_ids: boolean;
    // Optional. Can force the "state after the event" to be these events. Useful for testing /state_ids responses.
    precalculated_state_after?: Record<EventID, Array<EventID>>;
    // Optional. If true, when this file is loaded it will start at the first event rather than the last event. Default: false.
    // In general, starting at the beginning is only useful for tutorials.
    on_load_at_start: boolean;
    // Optional. Can set custom strings for nodes (events) or on the graph in general (title). Use '\n\' to get line breaks
    // both in the file and rendered.
    annotations?: {
        title?: string;
        titles: Record<EventID, string>;
        events: Record<EventID, string>;
    };
}

export interface ScenarioEvent {
    // subset of MatrixEvent
    event_id: string;
    type: string;
    state_key?: string;
    // biome-ignore lint/suspicious/noExplicitAny: we don't know the values.
    content: Record<string, any>;
    sender: string;
    prev_events: Array<string>;
    auth_events: Array<string>;
    origin_server_ts?: number;
    room_id?: string;
}

// Scenario is a loaded scenario for use with tardis. ScenarioFiles end up being represented as Scenarios.
export interface Scenario {
    // The events in this scenario, in the order they should be processed (typically topologically sorted).
    events: Array<MatrixEvent>;
    // The room version for these events
    roomVersion: string;
    // Pre-calculated state (useful for /state_ids responses, or for just demoing tardis without a shim!)
    precalculatedStateAfter?: Record<EventID, Array<EventID>>;
    // If true, when this scenario is loaded, start at the first event.
    onLoadAtStart: boolean;
    // Any annotations for the graph.
    annotations?: {
        title?: string;
        titles?: Record<EventID, string>;
        events?: Record<string, string>;
    };
}

// loadScenarioFromFile loads a scenario file (.json5) or new-line delimited JSON / JSON array, which represents the events in the scenario,
// in the order they should be processed.
// Throws if there is malformed events or malformed data. Requires `globalThis.gmslEventIDForEvent` to exist (loaded via gmsl.wasm).
export async function loadScenarioFromFile(f: File): Promise<Scenario> {
    // read the file
    const eventsOrScenario = await new Promise(
        (resolve: (value: Array<MatrixEvent> | ScenarioFile) => void, reject) => {
            const reader = new FileReader();
            reader.onload = (data) => {
                if (!data.target || !data.target.result) {
                    return;
                }
                if (f.name.endsWith(".json5")) {
                    // scenario file
                    const sfJson = JSON5.parse(data.target.result as string);
                    if (sfJson.on_load_at_start == null) {
                        sfJson.on_load_at_start = false;
                    }
                    if (sfJson.calculate_event_ids == null) {
                        sfJson.calculate_event_ids = false;
                    }
                    if (sfJson.room_version == null) {
                        sfJson.room_version = DEFAULT_ROOM_VERSION;
                    }
                    resolve(sfJson as ScenarioFile);
                    return;
                }
                const contents = data.target.result as string;
                if (contents.startsWith("[")) {
                    // it's a json array, resolve as-is.
                    const j = JSON.parse(contents);
                    resolve(j as Array<MatrixEvent>);
                    return;
                }
                // it's ndjson
                const ndjson = contents
                    .split("\n")
                    .filter((line) => {
                        return line.trim().length > 0;
                    })
                    .map((line) => {
                        const j = JSON.parse(line);
                        return j;
                    });
                resolve(ndjson as Array<MatrixEvent>);
            };
            reader.readAsText(f);
        },
    );
    // work out which file format we're dealing with and make a scenario file
    let scenarioFile: ScenarioFile;
    if (Array.isArray(eventsOrScenario)) {
        scenarioFile = {
            tardis_version: 1,
            room_version: DEFAULT_ROOM_VERSION,
            room_id: eventsOrScenario[0].room_id,
            calculate_event_ids: false,
            on_load_at_start: false,
            events: eventsOrScenario,
        };
    } else {
        // it's a test scenario
        scenarioFile = eventsOrScenario;
    }
    return loadScenarioFromScenarioFile(scenarioFile);
}

export function loadScenarioFromScenarioFile(scenarioFile: ScenarioFile): Scenario {
    const scenario: Scenario = {
        events: [],
        roomVersion: scenarioFile.room_version,
        annotations: scenarioFile.annotations,
        precalculatedStateAfter: scenarioFile.precalculated_state_after,
        onLoadAtStart: scenarioFile.on_load_at_start,
    };
    // validate and preprocess the scenario file into a valid scenario
    const fakeEventIdToRealEventId = new Map<string, string>();
    let time = new Date(2024, 0, 1).getTime();
    for (const ev of scenarioFile.events) {
        if (!ev) {
            throw new Error("missing event");
        }
        if (!ev.event_id) {
            throw new Error(`event is missing 'event_id', got ${JSON.stringify(ev)}`);
        }
        if (!ev.type) {
            throw new Error(`event is missing 'type' field, got ${JSON.stringify(ev)}`);
        }
        if (!ev.origin_server_ts) {
            ev.origin_server_ts = time;
            time += 1000;
        } else {
            time = ev.origin_server_ts + 1000;
        }
        if (!ev.room_id && scenarioFile.room_id) {
            ev.room_id = scenarioFile.room_id;
        }
        if (scenarioFile.calculate_event_ids) {
            const fakeEventId = ev.event_id;
            // replace any references in prev_events and auth_events
            for (const key of ["prev_events", "auth_events"]) {
                const replacement: Array<string> = [];
                for (const eventIdToReplace of ev[key]) {
                    const realEventId = fakeEventIdToRealEventId.get(eventIdToReplace);
                    if (realEventId) {
                        replacement.push(realEventId);
                    } else {
                        replacement.push(eventIdToReplace);
                    }
                }
                ev[key] = replacement;
            }
            // replace the fake event ID AFTER we mutate the event to set prev/auth events
            const realEventId = globalThis.gmslEventIDForEvent(JSON.stringify(ev), scenarioFile.room_version);
            fakeEventIdToRealEventId.set(fakeEventId, realEventId);
            ev.event_id = realEventId;

            // also replace any references in annotations
            if (scenario.annotations?.events?.[fakeEventId]) {
                scenario.annotations.events[realEventId] = scenario.annotations.events[fakeEventId];
            }
            if (scenario.annotations?.titles?.[fakeEventId]) {
                scenario.annotations.titles[realEventId] = scenario.annotations.titles[fakeEventId];
            }
        }
        scenario.events.push(ev as MatrixEvent);
    }
    // also also replace any references in precalculatedStateAfter AFTER we've processed all events
    if (scenario.precalculatedStateAfter) {
        for (const fakeAtStateEventId in scenario.precalculatedStateAfter) {
            const realAtStateEventId = fakeEventIdToRealEventId.get(fakeAtStateEventId);
            if (!realAtStateEventId) {
                console.error(
                    `precalculated_state_after references ${fakeAtStateEventId} but this does not exist in the events array. Skipping.`,
                );
                continue;
            }
            const stateAtEvent: string[] = [];
            for (const fakeStateEventId of scenario.precalculatedStateAfter[fakeAtStateEventId]) {
                const e = fakeEventIdToRealEventId.get(fakeStateEventId);
                if (e) {
                    stateAtEvent.push(e);
                } else {
                    console.error(
                        `precalculated_state_after for ${fakeAtStateEventId} references ${fakeStateEventId} but this does not exist in the events array. Skipping.`,
                    );
                }
            }
            scenario.precalculatedStateAfter[realAtStateEventId] = stateAtEvent;
            delete scenario.precalculatedStateAfter[fakeAtStateEventId];
        }
    }
    console.log(scenario);
    return scenario;
}

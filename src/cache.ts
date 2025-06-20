import type { EventID, MatrixEvent, StateKeyTuple } from "./state_resolver";

export class Cache {
    stateAtEvent: StateAtEvent;
    eventCache: EventCache;
    constructor() {
        this.stateAtEvent = new StateAtEvent();
        this.eventCache = new EventCache();
    }
}

export class StateAtEvent {
    // private as we may want to do funny shenanigans later one e.g cache the result in indexeddb
    private state: Record<EventID, Record<StateKeyTuple, EventID>>;

    constructor() {
        this.state = {};
    }

    setState(eventId: EventID, events: Record<StateKeyTuple, EventID>) {
        this.state[eventId] = events;
        console.log(`StateAtEvent ${eventId} is`, events);
    }

    getStateAsEventIds(eventId: EventID): Set<EventID> {
        if (!this.state[eventId]) {
            return new Set();
        }
        return new Set(Object.values(this.state[eventId]));
    }

    getState(eventId: EventID): Record<StateKeyTuple, EventID> {
        if (!this.state[eventId]) {
            return {};
        }
        return JSON.parse(JSON.stringify(this.state[eventId]));
    }

    /**
     * For each event ID provided, retrieve the state at each event and return the inverse
     * lookup. This is useful for plotting state sets as you need to know which state sets
     * a random state event is part of when drawing that row.
     * @returns A map from an arbitrary state event ID to one or more of the `eventIDs` provided,
     * which indicates that this arbitrary state event is part of the state set for that event(s).
     */
    getInverseStateForEventIds(eventIDs: Set<EventID>): Record<EventID, Set<EventID>> {
        const result: Record<EventID, Set<EventID>> = {};
        for (const id of eventIDs) {
            const stateAtEvent = this.getStateAsEventIds(id);
            // now store the inverse lookup
            for (const stateEventId of stateAtEvent) {
                const existingState = result[stateEventId] || new Set<EventID>();
                existingState.add(id);
                result[stateEventId] = existingState;
            }
        }
        return result;
    }
}

export class EventCache {
    cache: Map<string, MatrixEvent>;
    constructor() {
        // in-memory for now, but could be stored in idb or elsewhere.
        this.cache = new Map<string, MatrixEvent>();
    }
    store(ev: MatrixEvent) {
        this.cache.set(ev.event_id, ev);
    }
    get(eventId: string): MatrixEvent | undefined {
        return this.cache.get(eventId);
    }
}

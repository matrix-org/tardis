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

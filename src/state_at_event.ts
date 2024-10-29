import type { EventID, StateKeyTuple } from "./state_resolver";

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

    // setResolver(func())
}

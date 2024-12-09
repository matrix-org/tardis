import type { MatrixEvent } from "./state_resolver";

export class EventList {
    private highlightedEventId: string;
    private positionListener: (eventId: string) => void;
    private jsonListener: (eventId: string) => void;
    constructor(
        readonly container: HTMLElement,
        readonly template: HTMLTemplateElement,
    ) {}

    clear(): void {
        this.container.innerHTML = "";
    }

    onEventClick(fn): void {
        this.positionListener = fn;
    }
    onEventJsonClick(fn): void {
        this.jsonListener = fn;
    }

    private onCellClick(ev) {
        this.onClick(ev, this.positionListener);
    }

    private onJsonClick(ev) {
        this.onClick(ev, this.jsonListener);
    }

    private onClick(ev, fn) {
        const row = ev.target?.parentElement;
        if (!row) {
            return;
        }
        const eventId = row.getAttribute("id");
        if (eventId && fn) {
            fn(eventId);
        }
    }

    appendEvent(index: number, ev: MatrixEvent) {
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
        const row = this.template.content.firstElementChild!.cloneNode(true) as HTMLDivElement;
        row.setAttribute("id", ev.event_id);
        const prefix = row.getElementsByClassName("eventlistrowprefix")[0];
        prefix.textContent = String(index);
        row.addEventListener("click", this.onCellClick.bind(this));
        const jsonButton = row.getElementsByClassName("eventlistrowjson")[0];
        jsonButton.addEventListener("click", this.onJsonClick.bind(this));
        row.getElementsByClassName("eventlistrowbody")[0].textContent = textRepresentation(ev);
        row.getElementsByClassName("eventlistroweventid")[0].textContent = ev.event_id.substr(0, 5);
        if (ev.state_key != null) {
            row.style.fontWeight = "600";
        }
        this.container.appendChild(row);
    }

    highlight(eventId: string) {
        if (this.highlightedEventId) {
            const oldElement = document.getElementById(this.highlightedEventId);
            if (oldElement) {
                oldElement.style.backgroundColor = "";
            }
        }
        document.getElementById(eventId)!.style.backgroundColor = "#6f8ea9";
        this.highlightedEventId = eventId;
    }
}

export function textRepresentation(ev: MatrixEvent): string {
    let stateDescription = "";
    let messageDescription = "";
    if (ev.state_key != null) {
        switch (ev.type) {
            case "m.room.create":
                stateDescription = `by ${ev.content.creator}`;
                break;
            case "m.room.member":
                stateDescription = `${ev.state_key}=${ev.content.membership}`;
                break;
            case "m.room.join_rules":
                stateDescription = `(${ev.content.join_rule})`;
                break;
            case "m.room.history_visibility":
                stateDescription = `(${ev.content.history_visibility})`;
                break;
            case "m.room.name":
                stateDescription = `(${ev.content.name})`;
                break;
            case "m.room.topic":
                stateDescription = `(${ev.content.topic})`;
                break;
            default:
                if (ev.state_key !== "") {
                    stateDescription = ev.state_key;
                }
        }
    } else {
        switch (ev.type) {
            case "m.reaction":
                messageDescription = ev.content["m.relates_to"]?.key;
                break;
            case "m.room.message":
                messageDescription = ev.content.body;
                break;
        }
    }
    return `${ev.type} ${stateDescription}${messageDescription}`;
}

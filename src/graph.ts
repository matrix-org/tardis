import * as d3 from "d3";
import { textRepresentation } from "./event_list";
import type { Scenario } from "./scenario";
import type { EventID, MatrixEvent } from "./state_resolver";

export interface RenderOptions {
    currentEventId: string;
    stateAtEvent?: Set<EventID>;
    scenario?: Scenario;
    showAuthChain: boolean;
    showAuthDAG: boolean;
}

interface RenderableMatrixEvent extends MatrixEvent {
    prev_auth_events: Array<string>; // until MatrixEvent knows about it
    authed_list: Array<string>; // list of events which this one is authenticated by in an auth DAG
    auth_list: Array<string>; // list of events which this one authenticates in an auth DAG
    next_events: Array<string>;
    x: number;
    y: number;
    laneWidth: number;
    streamPosition: number;
    authLane: number; // which lane for auth events which point to this event, if any
    authLaneStart: number; // what's the oldest auth lane in play at this event (for layout)
}

// const edgesForEvent = (ev: RenderableMatrixEvent, opts: RenderOptions): string[] => {
//     if (opts.showAuthChain) {
//         return (ev.prev_events || []).concat(ev.auth_events || []);
//     }
//     return ev.prev_events;
// };

const textualRepresentation = (ev: RenderableMatrixEvent, scenario?: Scenario) => {
    const eventId = ev.event_id;
    if (scenario?.annotations?.events?.[eventId]) {
        return `${scenario?.annotations?.events[eventId]}`;
    }
    const text = textRepresentation(ev);
    const collapse = ev._collapse ? `+${ev._collapse} more` : "";
    return `${text} ${collapse}`;
};

const redraw = (vis: HTMLDivElement, events: MatrixEvent[], opts: RenderOptions) => {
    // copy the events so we don't alter the caller's copy
    // biome-ignore lint/style/noParameterAssign:
    events = JSON.parse(JSON.stringify(events));
    // sort events chronologically
    const data: Array<RenderableMatrixEvent> = events; // .sort((a, b) => a.origin_server_ts - b.origin_server_ts);

    const eventsById: Map<string, RenderableMatrixEvent> = new Map();
    for (let i = 0; i < data.length; i++) {
        data[i].streamPosition = i;
        eventsById.set(data[i].event_id, data[i]);
    }

    // and insert potential placeholders for dangling edges.
    // we slice to do a shallow copy given we're inserting placeholders into data
    for (const d of data.slice()) {
        // order parents chronologically
        d.prev_events = d.prev_events.sort((a: string, b: string) => {
            return (eventsById.get(a)?.streamPosition || 0) - (eventsById.get(b)?.streamPosition || 0);
        });
        // order auth events reverse chronologically
        d.auth_events = d.auth_events.sort((a: string, b: string) => {
            return (eventsById.get(b)?.streamPosition || 0) - (eventsById.get(a)?.streamPosition || 0);
        });
        // remove auth events that point to create events, as they are very duplicative.
        //d.auth_events = d.auth_events.filter(id => eventsById.get(id)?.type !== 'm.room.create');

        for (const p of d.prev_events) {
            if (!eventsById.get(p)) {
                const placeholder = {
                    event_id: p,
                    type: "dangling",
                    prev_events: [],
                    next_events: [],
                    content: {},
                    sender: "dangling",
                    auth_events: [],
                    room_id: "",
                    origin_server_ts: 0,
                };
                eventsById.set(p, placeholder);
                // insert the placeholder immediately before the event which refers to it
                const i = data.findIndex((ev) => ev.event_id === d.event_id);
                console.log("inserting placeholder prev_event at ", i);
                data.splice(i, 0, placeholder);
            }

            // update children on parents
            const parent = eventsById.get(p)!;
            if (!parent.next_events) parent.next_events = [];
            //console.log(`push ${d.event_id} onto ${parent.event_id}.next_events`);
            parent.next_events.push(d.event_id);
        }
    }

    // which lanes are in use for prev_events that point to a given event_id
    // so we know how to fill up the lanes.
    const lanes: Array<string> = [];
    // the height at which a given lane ended (i.e. was terminated)
    const laneEnd: Array<number> = [];

    // for balanced layout:
    const balanced = false;
    const laneWidth = 100;
    if (balanced) {
        lanes.length = laneWidth;
        laneEnd.length = laneWidth;
    }

    function getNextLane(after: number | null = null) {
        if (balanced) {
            // biome-ignore lint/style/noParameterAssign:
            if (after == null) after = 0;
            // finds the next empty lane
            // if (after >= lanes.length) return after;

            let foundAfter = false;
            for (let i = 0; i < lanes.length; i++) {
                // 0, -1, 1, -2, 2, -3, 3 etc.
                let x = Math.ceil(i / 2) * (((i + 1) % 2) * 2 - 1);
                x += laneWidth / 2;
                if (after) {
                    if (after === x) {
                        foundAfter = true;
                        continue;
                    }
                    if (!foundAfter) continue;
                }
                if (!lanes[x]) return x;
            }
        } else {
            const startingAt = after == null ? 0 : after + 1;
            // finds the next empty lane
            if (startingAt >= lanes.length) return startingAt;

            for (let i = startingAt; i < lanes.length; i++) {
                if (!lanes[i]) return i;
            }

            return lanes.length;
        }
    }

    data[0].x = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        // console.log(
        //     y,
        //     d.event_id.slice(0, 5),
        //     d.sender,
        //     d.type,
        //     lanes.map((id) => id?.substr(0, 5)).join(", "),
        //     `p:${d.prev_events.map((id) => id.substr(0, 5)).join(", ")}`,
        //     `n:${d.next_events?.map((id) => id.substr(0, 5)).join(", ")}`,
        // );

        d.y = i;

        // if any of my parents has a lane, position me under it, preferring the oldest
        let foundLane = false;
        for (const p of d.prev_events!) {
            const parent = eventsById.get(p)!;
            if (lanes.findIndex((id) => id === parent.event_id) !== -1) {
                d.x = parent.x;
                foundLane = true;
            }
            break;
        }

        // otherwise, start a new lane
        if (!foundLane) {
            // don't re-use lanes if you have prev_events higher than the end of the lane
            // otherwise you'll overlap them.
            d.x = getNextLane();
            if (d.prev_events && eventsById.get(d.prev_events[0])) {
                const oldestPrevEventY = eventsById.get(d.prev_events[0])!.y;
                while (laneEnd[d.x] !== undefined && oldestPrevEventY < laneEnd[d.x]) {
                    d.x = getNextLane(d.x);
                }
            }
        }

        // if am not the oldest parent of any of my children, terminate this lane,
        // as they will never try to position themselves under me.
        let oldestParent = false;
        if (d.next_events) {
            for (const c of d.next_events) {
                const child = eventsById.get(c);
                if (child!.prev_events![0] === d.event_id) {
                    oldestParent = true;
                    break;
                }
            }
        }

        if (oldestParent) {
            // label this lane with my id for the benefit of whatever child
            // will go under it, to stop other nodes grabbing it
            lanes[d.x] = d.event_id;
        } else {
            //console.log(`terminating lane ${d.x}`);
            delete lanes[d.x];
            laneEnd[d.x] = i;
        }
    }

    // the current list of authLanes on the go, so we know where to insert new ones.
    const authLanes: Array<string> = [];

    function getNextAuthLane(y1: number, y2: number) {
        let rightHandEdge = 0;
        for (let y = y1; y <= y2; y++) {
            rightHandEdge = data[y].x > rightHandEdge ? data[y].x : rightHandEdge;
            // XXX: alternatively, we could push out beyond the prev-event laneWidth
            // to avoid crisscrossing the prev-event DAG with the auth DAG
        }
        rightHandEdge++;
        // XXX: ideally we'd ensure that the oldest lane keeps getting pushed out by newer ones
        // as we find them, rather than just appending like this.
        // So, we'd find the right slot based on comparing y1 with the y offsets of the
        // events for these lanes, and then shuffle the events over if needed.
        // however, this would be tricky when reusing lanes, as the order will break.
        while (authLanes[rightHandEdge] !== undefined) {
            rightHandEdge++;
        }
        return rightHandEdge;
    }

    // pass from bottom to top to figure out auth dag
    for (let i = data.length - 1; i >= 0; i--) {
        const d = data[i];
        const authEvents = opts.showAuthChain ? d.auth_events : opts.showAuthDAG ? d.prev_auth_events : undefined;
        if (!authEvents) continue;

        if (opts.showAuthDAG) {
            // walk the DAG to the root to get authed & authing events
            const walk = (e) => {
                e.authed_list ||= [];
                e.authed_list.push(d.event_id);
                for (const id of e.prev_auth_events) {
                    walk(eventsById.get(id));
                }
            };
            walk(d);
        }

        d.auth_list = [];
        for (const id of authEvents) {
            d.auth_list.push(id);
            const p = eventsById.get(id)!;
            if (!p.authLane) {
                const lane = getNextAuthLane(p.y, i);
                p.authLane = lane;
                authLanes[lane] = id;
                p.authLaneStart = authLanes.findIndex((lane) => lane !== undefined) - 1;
            }
        }
        // reclaim lanes once we've moved past their events
        if (d.authLane) {
            delete authLanes[d.authLane];
        }
    }

    const balanceTwoWayForks = true;

    // another pass to figure out the right-hand edge
    let maxAuthLane = 0;
    let maxAuthLaneStart = 0;
    const edges: Array<{ x: number; y: number }> = [];
    data[0].laneWidth = 0;
    for (let i = 1; i < data.length; i++) {
        const p = data[i - 1];
        const d = data[i];
        if (p.authLane > maxAuthLane) {
            maxAuthLane = p.authLane;
            maxAuthLaneStart = p.authLaneStart;
        }
        while (edges.length > 0 && i > edges.at(-1)?.y) edges.pop();
        if (p.next_events) {
            edges.push({
                x: eventsById.get(p.next_events.at(-1)).x,
                y: eventsById.get(p.next_events.at(-1)).y,
            });
        }
        edges.sort((a, b) => a.x - b.x);
        d.laneWidth = edges.at(-1)?.x;
        if (balanceTwoWayForks && d.laneWidth % 2) {
            // balance simple 2-way forks
            d.x -= 0.5;
            d.laneWidth -= 0.5;
        }
    }

    const margin = {
        top: 20,
        right: 20,
        bottom: 30,
        left: 230,
    };

    let currTitle = opts.scenario?.annotations?.titles?.[opts.currentEventId];
    if (!currTitle) {
        // ...fallback to the global title or nothing
        currTitle = opts.scenario?.annotations?.title || "";
    }
    const lines = currTitle.split("\n");
    const lineHeight = 20;

    //
    // Drawing operations below
    //
    const gx = 40; // horizontal grid spacing
    const gy = 25; // vertical grid spacing
    const r = 5; // node size

    const lineWidth = 2;
    const lineWidthHighlight = 3;

    const authLineWidth = 1;
    const authLineWidthHighlight = 3;

    const prevColor = "#f00";
    const currColor = "#0a0";
    const nextColor = "#00f";
    const prevAuthColor = "#faa";
    const nextAuthColor = "#aaf";
    const authColor = "#888";

    // empty vis div
    d3.select(vis).html(null);

    // determine width & height of parent element and subtract the margin
    const width = lanes.length * gx + 1000;
    const height = data.length * gy;

    // create svg and create a group inside that is moved by means of margin
    const svg = d3
        .select(vis)
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom + lineHeight * lines.length)
        .append("g")
        .attr("transform", `translate(${[margin.left, margin.top]})`);

    const node = svg
        .selectAll("g")
        .data(data)
        .enter()
        .append("g")
        .attr("class", (d) => `node-${d.event_id.slice(1, 5)}`)
        .on("mouseover", function (e, d) {
            const node = d3.select(this);
            node.attr("fill", currColor).attr("font-weight", "bold");

            d3.selectAll(`.child-${d.event_id.slice(1, 5)}`)
                .raise()
                .attr("stroke", nextColor)
                .attr("stroke-width", lineWidthHighlight);
            d3.selectAll(`.parent-${d.event_id.slice(1, 5)}`)
                .raise()
                .attr("stroke", prevColor)
                .attr("stroke-width", lineWidthHighlight);

            d3.selectAll(`.authchild-${d.event_id.slice(1, 5)}`)
                .raise()
                .attr("stroke", nextAuthColor)
                .attr("stroke-width", authLineWidthHighlight);
            // .each(function() {
            //     d3.select(this.parentNode).raise();
            // });
            d3.selectAll(`.authparent-${d.event_id.slice(1, 5)}`)
                .raise()
                .attr("stroke", prevAuthColor)
                .attr("stroke-width", authLineWidthHighlight);
            // .each(function() {
            //     d3.select(this.parentNode).raise();
            // });

            for (const id of d.next_events || []) {
                d3.select(`.node-${id.slice(1, 5)}`).attr("fill", nextColor);
            }
            for (const id of d.prev_events!) {
                d3.select(`.node-${id.slice(1, 5)}`).attr("fill", prevColor);
            }
        })
        .on("mouseout", function (e, d) {
            d3.select(this).attr("fill", null).attr("font-weight", null);

            for (const id of d.next_events || []) {
                d3.select(`.node-${id.slice(1, 5)}`).attr("fill", null);
            }
            for (const id of d.prev_events!) {
                d3.select(`.node-${id.slice(1, 5)}`).attr("fill", null);
            }

            d3.selectAll(`.child-${d.event_id.slice(1, 5)}`)
                .attr("stroke", "black")
                .attr("stroke-width", lineWidth);
            d3.selectAll(`.parent-${d.event_id.slice(1, 5)}`)
                .attr("stroke", "black")
                .attr("stroke-width", lineWidth);

            d3.selectAll(`.authchild-${d.event_id.slice(1, 5)}`)
                .attr("stroke", authColor)
                .attr("stroke-width", authLineWidth);
            d3.selectAll(`.authparent-${d.event_id.slice(1, 5)}`)
                .attr("stroke", authColor)
                .attr("stroke-width", authLineWidth);
        });

    // draw data points
    node.append("circle")
        .attr("cx", (d) => d.x * gx)
        .attr("cy", (d) => d.y * gy)
        .attr("r", r)
        .style("fill", (d) => {
            if (opts.stateAtEvent?.has(d.event_id)) {
                return "#43ff00";
            }
            return d.state_key != null ? "#4300ff" : "#111111";
        })
        .style("fill-opacity", "0.5")
        .style("stroke", (d) => {
            if (opts.stateAtEvent?.has(d.event_id)) {
                return "#43ff00";
            }
            return d.state_key != null ? "#4300ff" : "#111111";
        });

    const nudgeOffset = 0;

    // next-events outlines
    if (!nudgeOffset) {
        node.append("path")
            .attr("d", (d) => {
                const path = d3.path();
                if (d.next_events) {
                    for (const child of d.next_events) {
                        const c = eventsById.get(child);
                        path.moveTo(d.x * gx, d.y * gy + r);
                        path.arcTo(d.x * gx, (d.y + 0.5) * gy, c.x * gx, (d.y + 0.5) * gy, r);
                        path.arcTo(c.x * gx, (d.y + 0.5) * gy, c.x * gx, c.y * gy - r, r);
                        path.lineTo(c.x * gx, c.y * gy - r);
                    }
                }

                return path;
            })
            .attr("stroke", "white")
            .attr("stroke-width", lineWidth + 2)
            .attr("fill", "none");
    }

    // links
    node.each((d, i, nodes) => {
        const n = d3.select(nodes[i]);

        if (d.next_events) {
            let childIndex = 0;
            for (const child of d.next_events) {
                const c = eventsById.get(child);
                if (!c) continue;

                const path = d3.path();

                let nudge_x = 0;
                let nudge_y = 0;

                if (nudgeOffset) {
                    // nudge horizontal up or down based on how many next_events there are from this node.
                    nudge_y =
                        d.next_events.length > 1 ? nudgeOffset * (childIndex - (d.next_events.length - 2) / 2) : 0;
                    // nudge vertical left or right based on how many prev_events there are from this child.
                    const childParentIndex = c.prev_events!.findIndex((id) => id === d.event_id);
                    nudge_x = nudgeOffset * (childParentIndex - (c.prev_events!.length - 1) / 2);
                }

                path.moveTo(d.x * gx, d.y * gy + r + nudge_y);

                // path.lineTo(c.x * g, d.y * gy);
                // path.lineTo(c.x * g, c.y * gy);
                // path.quadraticCurveTo(c.x * gx, d.y * gy, c.x * gx, c.y * gy);

                // path.arcTo(c.x * gx, d.y * gy, c.x * gx, c.y * gy, gy/2);
                // path.lineTo(c.x * gx, c.y * gy);

                if (nudgeOffset) {
                    path.lineTo(d.x * gx, (d.y + 0.5) * gy + nudge_y);
                    path.lineTo(c.x * gx + nudge_x, (d.y + 0.5) * gy + nudge_y);
                } else {
                    path.arcTo(d.x * gx, (d.y + 0.5) * gy, c.x * gx, (d.y + 0.5) * gy, r);
                    path.arcTo(c.x * gx, (d.y + 0.5) * gy, c.x * gx, c.y * gy - r, r);
                }

                path.lineTo(c.x * gx + nudge_x, c.y * gy - r);

                // arrowhead - we draw one per link so that prev_event highlighting works
                path.moveTo(d.x * gx - r / 3, d.y * gy + r + r / 2);
                path.lineTo(d.x * gx, d.y * gy + r);
                path.lineTo(d.x * gx + r / 3, d.y * gy + r + r / 2);
                path.lineTo(d.x * gx - r / 3, d.y * gy + r + r / 2);
                path.lineTo(d.x * gx, d.y * gy + r);

                childIndex++;

                n.append("path")
                    .attr("d", path.toString())
                    .attr("class", (d) => `child-${d.event_id.slice(1, 5)} parent-${c?.event_id.slice(1, 5)}`)
                    .attr("stroke", "black")
                    .attr("stroke-width", lineWidth)
                    .attr("fill", "none");
            }
        }
    });

    // auth chains
    const agx = gx / 2; // tighter grid for auth events

    if (opts.showAuthChain || opts.showAuthDAG) {
        node.each((d, i, nodes) => {
            const n = d3.select(nodes[i]);

            const authEvents = opts.showAuthChain ? d.auth_events : d.prev_auth_events;
            if (authEvents) {
                for (const parent of authEvents) {
                    const p = eventsById.get(parent);
                    if (!p) continue;

                    const path = d3.path();

                    const nudge_y = 0;
                    const nudge_x = 0;

                    // XXX: is authLaneStart going to be constant enough for this to work?
                    const authOffset = p.authLaneStart * gx + (p.authLane - p.authLaneStart) * agx;

                    path.moveTo(d.x * gx + r + nudge_x, d.y * gy + nudge_y);
                    path.arcTo(authOffset, d.y * gy + nudge_y, authOffset, p.y * gy + nudge_y, r * 2);
                    path.arcTo(authOffset, p.y * gy + nudge_y, p.x * gx + r + nudge_x, p.y * gy + nudge_y, r * 2);
                    // path.lineTo(p.authLane * gx, d.y * gy + nudge);
                    // path.lineTo(p.authLane * gx, p.y * gy + nudge);
                    path.lineTo(p.x * gx + r + nudge_x, p.y * gy + nudge_y);

                    // arrowhead
                    path.moveTo(p.x * gx + nudge_x + r + r / 2, p.y * gy + nudge_y + r / 3);
                    path.lineTo(p.x * gx + nudge_x + r, p.y * gy + nudge_y);
                    path.lineTo(p.x * gx + nudge_x + r + r / 2, p.y * gy + nudge_y - r / 3);
                    path.lineTo(p.x * gx + nudge_x + r + r / 2, p.y * gy + nudge_y + r / 3);
                    path.lineTo(p.x * gx + nudge_x + r, p.y * gy + nudge_y);

                    const classes = (d) => {
                        if (opts.showAuthChain) {
                            return `authchild-${p.event_id.slice(1, 5)} authparent-${d?.event_id.slice(1, 5)}`;
                        }
                        return (
                            d.authed_list.map((id) => `authparent-${id?.slice(1, 5)}`).join(" ") + ' ' +
                            d.auth_list.map((id) => `authchild-${id?.slice(1, 5)}`).join(" ")
                        );
                    };

                    n.append("path")
                        .attr("d", path.toString())
                        .attr("class", classes)
                        .attr("stroke", authColor)
                        .attr("stroke-width", 1)
                        // .attr("stroke-dasharray", `${lineWidth * 2},${lineWidth}`)
                        .attr("fill", "none");
                }
            }
        });
    }

    /*
    // auth chain made out of arcs
    node.each((d, i, nodes) => {
        const n = d3.select(nodes[i]);

        if (d.auth_events) {
            for (const parent of d.auth_events) {
                const p = eventsById.get(parent);
                if (!p) continue;

                const path = d3.path();

                path.moveTo(d.x * gx, d.y * gy);
                path.arcTo(
                    ((d.x + p.x) * 0.5 * gx) + ((d.y - p.y) * 0.5 * gy), (p.y + d.y) * 0.5 * gy,
                    p.x * gx, p.y * gy,
                    (d.y - p.y) * 0.5 * (gx + gy)/2
                );

                n.append("path")
                    .attr("d", path.toString())
                    // .attr("class", (d) => `child-${d.event_id.slice(1, 5)} parent-${c?.event_id.slice(1, 5)}`)
                    .attr("stroke", "#888")
                    .attr("stroke-width", 1)
                    .attr("stroke-dasharray", `${lineWidth * 2},${lineWidth}`)
                    .attr("fill", "none");
            }
        }
    });
    */

    const textOffset = (d) =>
        opts.showAuthChain || opts.showAuthDAG
            ? maxAuthLaneStart * gx + (maxAuthLane - maxAuthLaneStart) * agx
            : d.laneWidth * gx;

    // Add event IDs on the right side
    node.append("text")
        .text((d) => {
            return d.event_id.substr(0, 5);
        })
        .attr("x", (d) => textOffset(d) + agx)
        .attr("y", (d) => d.y * gy + 4);

    // Add descriptions alongside the event ID
    node.append("text")
        .text((d) => {
            return textualRepresentation(d, opts.scenario);
        })
        .attr("class", (d) => "node-text")
        // .text(
        //     (d) =>
        //         `${d.y} ${d.event_id.slice(0, 5)} ${d.sender} P:${d.prev_events.map((id) => id.slice(0, 5)).join(", ")} | N:${d.next_events?.map((id) => id.slice(0, 5)).join(", ")}`,
        // )
        //.text(d => `${d.y} ${d.event_id.substr(0, 5)} ${d.sender} ${d.type} prev:${d.prev_events.map(id => id.substr(0, 5)).join(", ")}`)
        .attr("x", (d) => textOffset(d) + agx + 70)
        .attr("y", (d) => d.y * gy + 4);

    node.append("text")
        .text((d) => (d.origin_server_ts ? new Date(d.origin_server_ts).toLocaleString() : ""))
        .attr("x", -margin.left)
        .attr("y", (d) => d.y * gy + 4);

    // use the title for the current event
    const title = svg.append("text").attr("class", "node-text").attr("x", -margin.left).attr("y", height);

    for (let i = 0; i < lines.length; i++) {
        title
            .append("tspan")
            .attr("x", -margin.left)
            .attr("y", height + i * lineHeight)
            .text(lines[i]);
    }
    //title.text(currTitle);
};

export { redraw };

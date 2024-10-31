import { describe, expect, it } from "@jest/globals";
import { type DataGetEvent, type DataResolveState, type MatrixEvent, StateResolver } from "./state_resolver";

const roomVer = "custom";
const roomId = "!foo";

describe("StateResolver", () => {
    describe("resolveState", () => {
        const eventMap: Record<string, MatrixEvent> = {
            $foo: {
                type: "m.room.create",
                state_key: "",
                content: {},
                auth_events: [],
                prev_events: [],
                event_id: "$foo",
                sender: "@alice",
                depth: 0,
                room_id: "!foo",
            },
            $foomember: {
                type: "m.room.member",
                state_key: "@alice",
                content: { membership: "join" },
                auth_events: [],
                prev_events: [],
                event_id: "$foomember",
                sender: "@alice",
                depth: 1,
                room_id: "!foo",
            },
            $bar: {
                type: "m.room.create",
                state_key: "",
                content: {},
                auth_events: [],
                prev_events: [],
                event_id: "$bar",
                sender: "@alice",
                depth: 0,
                room_id: "!foo",
            },
        };

        it("pairs up requests and sends the right request shape", async () => {
            const outstandingRequests: Array<{ id: string; data: DataResolveState }> = [];
            const sr = new StateResolver(
                {
                    sendResolveState: (id: string, data: DataResolveState) => {
                        outstandingRequests.push({
                            id: id,
                            data: data,
                        });
                    },
                },
                (data: DataGetEvent): MatrixEvent => {
                    return eventMap[data.event_id];
                },
            );
            // biome-ignore lint/complexity/useLiteralKeys: it reads much nicer in IDEs to use this form
            const fooState = [{ [`["m.room.create",""]`]: "$foo", [`["m.room.member","@alice"]`]: "$foomember" }];
            const promiseFoo = sr.resolveState(roomId, roomVer, fooState);
            let fooResolved = false;
            promiseFoo.then(() => {
                fooResolved = true;
            });
            // biome-ignore lint/complexity/useLiteralKeys: it reads much nicer in IDEs to use this form
            const barState = [{ [`["m.room.create",""]`]: "$bar" }];
            const promiseBar = sr.resolveState(roomId, roomVer, barState);
            let barResolved = false;
            promiseBar.then(() => {
                barResolved = true;
            });
            expect(outstandingRequests.length).toEqual(2);
            const fooRequest = outstandingRequests[0];
            expect(fooRequest.id).toBeDefined();
            expect(fooRequest.data).toEqual({
                room_id: "!foo",
                room_version: roomVer,
                state: fooState,
            });
            const barRequest = outstandingRequests[1];
            expect(barRequest.id).toBeDefined();
            expect(barRequest.data).toEqual({
                room_id: "!foo",
                room_version: roomVer,
                state: barState,
            });

            // neither promise should have resolved yet
            expect(fooResolved).toBe(false);
            expect(barResolved).toBe(false);

            // now resolve bar first even though it came last, to ensure we are pairing up based on the ID.
            sr.onResolveStateResponse(barRequest.id, {
                state: [],
                // biome-ignore lint/complexity/useLiteralKeys: it reads much nicer in IDEs to use this form
                result: { [`["m.room.create",""]`]: "$bar" },
                room_id: "!foo",
                room_version: roomVer,
            });
            const barResult = await promiseBar;
            expect(barResolved).toBe(true);
            expect(fooResolved).toBe(false);
            expect(barResult.state).toEqual({
                // biome-ignore lint/complexity/useLiteralKeys:
                [`["m.room.create",""]`]: "$bar",
            });

            sr.onResolveStateResponse(fooRequest.id, {
                state: [],
                // biome-ignore lint/complexity/useLiteralKeys: it reads much nicer in IDEs to use this form
                result: { [`["m.room.create",""]`]: "$foo" },
                room_id: "!foo",
                room_version: roomVer,
            });
            const fooResult = await promiseFoo;
            expect(fooResolved).toBe(true);
            expect(fooResult.state).toEqual({
                // biome-ignore lint/complexity/useLiteralKeys:
                [`["m.room.create",""]`]: "$foo",
            });
        });
    });
});
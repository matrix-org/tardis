#!/usr/bin/env python
import asyncio
import json
import logging
import os
import uuid
from typing import Collection, Dict, Iterable, List, Optional, Sequence, Set
from pydantic import BaseModel
from websockets.asyncio.server import serve

from twisted.internet import defer
from synapse.api.errors import AuthError
from synapse.api.room_versions import RoomVersions, KNOWN_ROOM_VERSIONS
from synapse.event_auth import (
    check_state_independent_auth_rules,
    check_state_dependent_auth_rules,
)
from synapse.storage.databases.main.events_worker import EventRedactBehaviour
from synapse.state.v2 import resolve_events_with_store
from synapse.events import EventBase, make_event_from_dict
from synapse.types import StateMap

logging.basicConfig(level=logging.DEBUG)


class WebSocketMessage(BaseModel):
    type: str
    id: str
    error: Optional[str] = None
    data: dict


class FakeClock:
    def sleep(self, msec: float) -> "defer.Deferred[None]":
        return defer.succeed(None)


class EventSourceStore:
    def __init__(self, conn):
        self.conn = conn

    async def get_events(
        self,
        event_ids: Collection[str],
        redact_behaviour: EventRedactBehaviour,
        get_prev_content: bool = False,
        allow_rejected: bool = False,
    ) -> Dict[str, "EventBase"]:
        return await self.conn.get_events(event_ids)


class Connection:
    event_map: Dict[str, EventBase] = {}

    def __init__(self, ws):
        self.ws = ws
        self.outstanding_requests = {}
        self.room_ver = RoomVersions.V10

    def event_source_store(self):
        return EventSourceStore(self)

    # Array<Record<StateKeyTuple, EventID>>
    async def resolve_state(
        self,
        id: str,
        room_id: str,
        room_ver_str: str,
        state_sets_wire_format: Sequence[Dict[str, str]],
        at_event_json: dict,
    ):
        print(f"resolve_state: {id} in {room_id} on version {room_ver_str}")
        if KNOWN_ROOM_VERSIONS.get(room_ver_str) is None:
            print(f"  resolve_state: {id} WARNING: unknown room version {room_ver_str}")

        self.room_ver = KNOWN_ROOM_VERSIONS[room_ver_str]
        print(f"resolve_state {state_sets_wire_format} at event {at_event_json}")

        # map the wire format to a form synapse wants, notably this is converting the JSON stringified tuples
        # back into real tuples
        state_sets: Sequence[StateMap[str]] = [
            {tuple(json.loads(k)): sswf[k] for k in sswf}
            for sswf in state_sets_wire_format
        ]
        r = await resolve_events_with_store(
            FakeClock(),
            room_id,
            self.room_ver,
            state_sets,
            event_map=None,
            state_res_store=self,
        )
        # use the state to auth the new event
        err_str = ""
        if at_event_json.get("state_key") is not None:
            print(f"authing at_event {at_event_json["type"]}")
            try:
                at_event_json.pop("event_id")
                at_event = make_event_from_dict(
                    at_event_json, room_version=self.room_ver
                )
                await check_state_independent_auth_rules(
                    self.event_source_store(), at_event
                )
                curr_state_event_ids = iter(r.values())
                curr_state_events = await self.get_events(curr_state_event_ids)
                check_state_dependent_auth_rules(
                    at_event, iter(curr_state_events.values())
                )
                print(f"event {at_event} passes auth checks!")
                r[(at_event.type, at_event.state_key)] = at_event.event_id
            except AuthError as err:
                print(f"event {at_event} failed auth checks! {err}")
                err_str = f"{err}"

        print(f"resolve_state: {id} responding")
        # convert tuple keys to strings
        r = {json.dumps(k): v for k, v in r.items()}
        await self.ws.send(
            json.dumps(
                {
                    "id": id,
                    "type": "resolve_state",
                    "data": {
                        "result": r,
                        "error": err_str,
                    },
                }
            )
        )
        return []

    async def get_event(self, event_id: str) -> EventBase:
        id = str(uuid.uuid4())
        print(f"    get_event {event_id} -> {id}")
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self.outstanding_requests[id] = fut
        await self.ws.send(
            json.dumps(
                {
                    "id": id,
                    "type": "get_event",
                    "data": {
                        "event_id": event_id,
                    },
                }
            )
        )
        await fut
        ev_dict = self.outstanding_requests[id].result()
        ev_dict.pop(
            "event_id"
        )  # wire format shouldn't have this, but tardis includes it.
        return make_event_from_dict(ev_dict, room_version=self.room_ver)

    async def get_events(
        self, event_ids: Collection[str], allow_rejected: bool = False
    ) -> Dict[str, EventBase]:
        """Get events from the database

        Args:
            event_ids: The event_ids of the events to fetch
            allow_rejected: If True return rejected events.

        Returns:
            Dict from event_id to event.
        """
        result = {}
        for event_id in event_ids:
            print(f"  get_event {event_id}")
            ev = await self.get_event(event_id)
            print(f"  get_event {event_id} obtained. type={ev["type"]}")
            result[event_id] = ev

        return result

    async def _get_auth_chain(self, event_ids: Iterable[str]) -> List[str]:
        """Gets the full auth chain for a set of events (including rejected
        events).

        Includes the given event IDs in the result.

        Note that:
            1. All events must be state events.
            2. For v1 rooms this may not have the full auth chain in the
               presence of rejected events

        Args:
            event_ids: The event IDs of the events to fetch the auth
                chain for. Must be state events.
        Returns:
            List of event IDs of the auth chain.
        """

        # Simple DFS for auth chain
        result = set()
        stack = list(event_ids)
        while stack:
            event_id = stack.pop()
            if event_id in result:
                continue

            result.add(event_id)

            event = self.event_map.get(event_id, None)
            if event is None:
                event = await self.get_event(event_id)
                self.event_map[event_id] = event
            for aid in event.auth_event_ids():
                stack.append(aid)

        return list(result)

    async def get_auth_chain_difference(
        self, room_id: str, auth_sets: List[Set[str]]
    ) -> Set[str]:
        chains = [frozenset(await self._get_auth_chain(a)) for a in auth_sets]
        common = set(chains[0]).intersection(*chains[1:])
        return set(chains[0]).union(*chains[1:]) - common


async def handler(websocket):
    c = Connection(websocket)
    async for message in websocket:
        try:
            wsm = WebSocketMessage(**json.loads(message))
            print(f"RECV {wsm.type} {wsm.id}")
            if wsm.type == "get_event":  # incoming response
                fut = c.outstanding_requests.get(wsm.id)
                if fut:
                    fut.set_result(wsm.data["event"])
            elif wsm.type == "resolve_state":  # incoming request
                # we can't await and return the response here because resolve_state needs to
                # call get_event which needs more WS messages, so we cannot block the processing
                # of incoming WS messages. When resolve_state concludes, it will send the response,
                # hence why we pass in the id here so it can pair it up.
                asyncio.create_task(
                    c.resolve_state(
                        wsm.id,
                        wsm.data["room_id"],
                        wsm.data["room_version"],
                        wsm.data["state"],
                        wsm.data["event"],
                    )
                )
            else:
                print(f"unknown type: {wsm.type}")
        except Exception as err:
            print(f"recv error {err}")


async def main():
    print(f"Running on commit {os.getenv("COMMIT")}", flush=True)
    print("Listening on 0.0.0.0:1234")
    async with serve(handler, "0.0.0.0", 1234):
        await asyncio.get_running_loop().create_future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

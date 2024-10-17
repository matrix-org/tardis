#!/usr/bin/env python
import asyncio
import json
import uuid
from typing import Dict, Optional, Sequence
from pydantic import BaseModel
from websockets.asyncio.server import serve

class WebSocketMessage(BaseModel):
    type: str
    id: str
    error: Optional[str] = None
    data: dict

class Connection:

    def __init__(self, ws):
        self.ws = ws
        self.outstanding_requests = {}

# Array<Record<StateKeyTuple, EventID>>
    async def resolve_state(self, id: str, state):
        print(f"resolve_state: {id}")
        for x in state:
            for _, event_id in x.items():
                print(f"  get_event {event_id}")
                ev = await self.get_event(event_id)
                print(f"  get_event {event_id} obtained. type={ev["type"]}")
        print(f"resolve_state: {id} responding")
        await self.ws.send(json.dumps({
            "id": id,
            "type": "resolve_state",
            "data": {
                "result": state, # echo it back for now
            }
        }))
        return []
    
    async def get_event(self, event_id: str) -> dict:
        id = str(uuid.uuid4())
        print(f"    get_event {event_id} -> {id}")
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self.outstanding_requests[id] = fut
        await self.ws.send(json.dumps({
            "id": id,
            "type": "get_event",
            "data": {
                "event_id": event_id,
            }
        }))
        await fut
        return self.outstanding_requests[id].result()


async def handler(websocket):
    c = Connection(websocket)
    async for message in websocket:
        try:
            wsm = WebSocketMessage(**json.loads(message))
            print(f"RECV {wsm.type} {wsm.id}")
            if wsm.type == "get_event": # incoming response
                fut = c.outstanding_requests.get(wsm.id)
                if fut:
                    fut.set_result(wsm.data["event"])
            elif wsm.type == "resolve_state": # incoming request
                # we can't await and return the response here because resolve_state needs to
                # call get_event which needs more WS messages, so we cannot block the processing
                # of incoming WS messages. When resolve_state concludes, it will send the response,
                # hence why we pass in the id here so it can pair it up.
                asyncio.create_task(c.resolve_state(wsm.id, wsm.data["state"]))
            else:
                print(f"unknown type: {wsm.type}")
        except Exception as err:
            print(f"recv error {err}")

async def main():
    print("Listening on 0.0.0.0:1234")
    async with serve(handler, "0.0.0.0", 1234):
        await asyncio.get_running_loop().create_future()  # run forever


if __name__ == '__main__':
    asyncio.run(main())
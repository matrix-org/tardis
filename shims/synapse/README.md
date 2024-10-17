## Synapse Shim

This is a shim for implementing Synapse's state resolution algorithms. It works by importing the relevant
Synapse libraries and calling it according to the TARDIS WebSockets API. Because it imports libraries within
Synapse, it may break between major Synapse releases.

The easiest way to use this shim is to build the Dockerfile (otherwise use a venv):

```
python -m venv ./venv
source ./venv/bin/activate
pip install -r requirements.txt
python shim.py
```
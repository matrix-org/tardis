## TARDIS - Time Agnostic Room DAG Inspection Service

TARDIS is a time-travelling debugger for Matrix room DAGs, which reads a plaintext file
to graphically visualise a room using [d3-dag](https://github.com/erikbrinkman/d3-dag) for
debugging purposes.

The original intention was to add it as a RightPanel widget to Element (particularly in p2p mode)
to help figure out what's gone wrong if your P2P node goes weird. The current intention is
to use it to explore the shape of public room DAGs to design better APIs for P2P federation.

It's effectively the real-life version of the 2014-vintage D3 "how matrix
works" animation from the frontpage of Matrix.org.

Currently very experimental and PoC.

## Generates stuff like this:

![](img/sugiyama.png)

![](img/zherebko.png)

### To use:

```
yarn install
yarn run start
```

Then provide a new-line delimited JSON file which contains events to render in the full federation format (with `prev_events`, etc).

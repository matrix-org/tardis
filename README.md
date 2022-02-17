## TARDIS - Time Agnostic Room DAG Inspection Service

TARDIS is a time-travelling debugger for Matrix room DAGs, which hooks into
Dendrite's internal APIs to graphically visualise a room using [d3-dag](https://github.com/erikbrinkman/d3-dag) for
debugging purposes.

The intention is to add it as a RightPanel widget to Element (particularly in p2p mode)
to help figure out what's gone wrong if your P2P node goes weird.

It's effectively the real-life version of the 2014-vintage D3 "how matrix
works" animation from the frontpage of Matrix.org.

Currently very experimental and PoC.

## Generates stuff like this:

![](img/sugiyama.png)

![](img/zherebko.png)

### To use:

Tweak the config in src/index.js, and:

```
yarn install
yarn run start
```

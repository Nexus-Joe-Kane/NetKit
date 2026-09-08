# Sample data

## `ofcom-coverage-sample.csv`

A three-row sample in the shape of Ofcom's Connected Nations postcode-level
mobile coverage file, used by the tests and useful for trying the coverage
panel before downloading the real thing.

Point `OFCOM_DATASET_PATH` at it to see live-mode coverage:

```bash
OFCOM_DATASET_PATH=docs/samples/ofcom-coverage-sample.csv npm start
```

Then look up `M1 1AE`, `LS1 4DY` or `W8 5TT` — those are the three postcodes
it covers. Any other postcode falls through to the demo engine, which is the
correct behaviour rather than a bug.

### The real file

Download the mobile coverage file from Ofcom's Connected Nations /
infrastructure research page. It is open data — free, no account.

Column headers have changed between releases, so NetKit **interprets** the
header rather than hard-coding it: each column is tokenised and matched for
an operator (`EE`, `VO`/`VF`, `TF`/`O2`, `H3`), a service (`voice`, `4G`,
`5G`, `3G`) and a placement (`indoor`/`outdoor`). Anything it does not
recognise is ignored. The admin status board reports how many postcodes were
indexed and how many columns it understood, so a format change shows up as a
degraded integration rather than silently empty data.

Values are Ofcom's 0–4 confidence scale, mapped to
none / poor / variable / good / excellent.

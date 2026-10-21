# Nested STEP assembly fixture

`nested-assembly.step` is a 56 KiB STEP AP214 assembly generated with CadQuery 2.5.2 / Open CASCADE 7.7. It contains this product tree:

```text
MainAssembly
├── Frame
└── Sensors
    ├── SensorLeft
    └── SensorRight
```

The nested assembly construction follows CadQuery's own import/export regression case, `test_nested_subassembly_step_import`, in [tests/test_assembly.py](https://github.com/CadQuery/cadquery/blob/master/tests/test_assembly.py). The fixture is checked in so the importer test does not need CadQuery at runtime. To regenerate it, install CadQuery 2.5.2 and run `python3 tests/fixtures/step/generate_nested_assembly.py`.

This is an external writer fixture because the bundled `occt-wasm` wrapper can export solids and compounds but does not author named XCAF product occurrences. It tests product relationships and names through a real STEP exchange file; it does not assert separate editable project components or preservation of every STEP placement/color feature.

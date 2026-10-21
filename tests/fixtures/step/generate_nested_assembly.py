"""Regenerate nested-assembly.step with CadQuery 2.5.2."""
from pathlib import Path
import cadquery as cq

def box(x: float, y: float, z: float) -> cq.Shape:
    return cq.Workplane("XY").box(x, y, z).val()

frame = cq.Assembly(box(20, 16, 2), name="Frame")
sensor_left = cq.Assembly(box(2, 2, 4), name="SensorLeft")
sensor_right = cq.Assembly(box(2, 2, 4), name="SensorRight")
sensors = cq.Assembly(name="Sensors")
sensors.add(sensor_left, loc=cq.Location((-4, 0, 3)))
sensors.add(sensor_right, loc=cq.Location((4, 0, 3)))
main = cq.Assembly(name="MainAssembly")
main.add(frame)
main.add(sensors)
destination = Path(__file__).with_name("nested-assembly.step")
main.save(str(destination), exportType="STEP")
# CadQuery emits formatting whitespace after some multiline STEP entities.
destination.write_text("\n".join(line.rstrip() for line in destination.read_text().splitlines()) + "\n")

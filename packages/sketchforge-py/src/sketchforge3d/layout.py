"""
The arithmetic every parameterised part repeats.

A row of holes and a bolt circle are the two things a macro computes before it
does anything interesting, and getting the centring or the first angle wrong is
the commonest way for a generated part to be subtly unusable.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional


@dataclass(frozen=True)
class Point2:
    x: float
    z: float


ORIGIN = Point2(0.0, 0.0)


def centered_offsets(count: int, spacing: float) -> List[float]:
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("A row needs a whole count of at least 1.")
    span = (count - 1) * spacing
    return [index * spacing - span / 2 for index in range(count)]


def row(count: int, spacing: float, center: Point2 = ORIGIN) -> List[Point2]:
    """
    ``count`` positions ``spacing`` apart, centred on ``center``.

    Centred rather than starting at the origin, because a row of holes is
    specified relative to the plate it is in, and an odd count should put one
    hole on the centreline.
    """
    return [Point2(center.x + offset, center.z) for offset in centered_offsets(count, spacing)]


def grid(
    columns: int,
    rows: int,
    spacing_x: float,
    spacing_z: float,
    center: Point2 = ORIGIN,
) -> List[Point2]:
    """A ``columns`` by ``rows`` grid, centred, with its own pitch in each direction."""
    across = centered_offsets(columns, spacing_x)
    down = centered_offsets(rows, spacing_z)
    return [Point2(center.x + column, center.z + line) for line in down for column in across]


def ring(
    count: int,
    radius: float,
    center: Point2 = ORIGIN,
    start_angle: float = 0.0,
) -> List[Point2]:
    """
    ``count`` positions evenly spaced on a circle of ``radius``.

    ``start_angle`` is in degrees and measured from +x towards +z, so 0 puts the
    first position at the three o'clock mark of the top view.
    """
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("A ring needs a whole count of at least 1.")
    start = math.radians(start_angle)
    return [
        Point2(
            center.x + radius * math.cos(start + index * 2 * math.pi / count),
            center.z + radius * math.sin(start + index * 2 * math.pi / count),
        )
        for index in range(count)
    ]


def mm(value: float, places: int = 4) -> float:
    """Rounded, so a computed position reads as a number rather than a float."""
    rounded = round(value, places)
    # -0.0 is the same position as 0.0 and reads as a bug in a reported angle.
    return rounded + 0.0 if rounded else 0.0


def angle_of(point: Point2, center: Optional[Point2] = None) -> float:
    """The position's angle in degrees, the way ``ring`` measures one."""
    origin = center or ORIGIN
    return math.degrees(math.atan2(point.z - origin.z, point.x - origin.x))

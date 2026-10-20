from __future__ import annotations

import math
import unittest

from sketchforge3d import Point2, angle_of, centered_offsets, grid, mm, ring, row


class RowTests(unittest.TestCase):
    def test_centres_an_odd_count_on_the_centreline(self) -> None:
        self.assertEqual([point.x for point in row(5, 20)], [-40, -20, 0, 20, 40])

    def test_straddles_the_centreline_for_an_even_count(self) -> None:
        self.assertEqual([point.x for point in row(2, 10)], [-5, 5])

    def test_offsets_the_whole_row_by_the_centre(self) -> None:
        self.assertEqual(row(3, 10, Point2(100, 7)), [Point2(90, 7), Point2(100, 7), Point2(110, 7)])

    def test_puts_a_single_position_on_the_centre(self) -> None:
        self.assertEqual(centered_offsets(1, 25), [0])

    def test_refuses_a_fractional_or_empty_count(self) -> None:
        for count in (2.5, 0, -1, True):
            with self.assertRaises(ValueError):
                row(count, 10)  # type: ignore[arg-type]


class GridTests(unittest.TestCase):
    def test_walks_columns_within_rows(self) -> None:
        self.assertEqual(
            grid(3, 2, 10, 4),
            [
                Point2(-10, -2),
                Point2(0, -2),
                Point2(10, -2),
                Point2(-10, 2),
                Point2(0, 2),
                Point2(10, 2),
            ],
        )


class RingTests(unittest.TestCase):
    def test_starts_at_three_oclock_and_goes_round_once(self) -> None:
        points = [(mm(point.x), mm(point.z)) for point in ring(4, 10)]
        self.assertEqual(points, [(10, 0), (0, 10), (-10, 0), (0, -10)])

    def test_honours_a_start_angle_in_degrees(self) -> None:
        first = ring(4, 10, start_angle=90)[0]
        self.assertEqual((mm(first.x), mm(first.z)), (0, 10))

    def test_offsets_the_circle_by_its_centre(self) -> None:
        first = ring(1, 5, center=Point2(2, 3))[0]
        self.assertEqual((mm(first.x), mm(first.z)), (7, 3))

    def test_spaces_positions_evenly_whatever_the_count(self) -> None:
        radii = {mm(math.hypot(point.x, point.z)) for point in ring(7, 25)}
        self.assertEqual(radii, {25})

    def test_reports_the_angle_a_position_sits_at(self) -> None:
        angles = [mm(angle_of(point)) for point in ring(4, 10)]
        self.assertEqual(angles, [0, 90, 180, -90])

    def test_refuses_an_empty_ring(self) -> None:
        with self.assertRaises(ValueError):
            ring(0, 10)


class MillimetreTests(unittest.TestCase):
    def test_rounds_away_negative_zero(self) -> None:
        self.assertEqual(repr(mm(-0.0000001)), "0.0")


if __name__ == "__main__":
    unittest.main()

from code_feedback import Feedback
from pl_helpers import name, points
from pl_unit_test import PLTestCase


class Test(PLTestCase):
    @points(2)
    @name("hours")
    def test_1(self):
        score = 0
        if Feedback.check_scalar(
            "hours", self.ref.hours, self.st.hours, accuracy_critical=False
        ):
            score += 1.0
        Feedback.set_score(score)

    @points(2)
    @name("composition")
    def test_2(self):
        score = 0
        if Feedback.check_numpy_array_allclose(
            "composition",
            self.ref.composition,
            self.st.composition,
            accuracy_critical=False,
        ):
            score += 1.0
        Feedback.set_score(score)

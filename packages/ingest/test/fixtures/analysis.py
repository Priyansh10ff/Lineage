import math
from dataclasses import dataclass


@dataclass
class Result:
    mean: float
    sd: float


def summarize(xs):
    """Mean and standard deviation."""
    m = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))
    return Result(m, sd)


if __name__ == "__main__":
    print(summarize([1, 2, 3]))

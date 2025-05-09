import random

import numpy as np
import prairielearn as pl


def generate(data):
    N = random.choice([2, 3])
    data["params"]["N"] = N
    for i in range(2):
        X = np.random.rand(N, N)
        name = "N" + str(i + 1)
        data["params"][name] = pl.to_json(X)
    for i in range(4):
        M = random.choice([j for j in range(2, 5) if j != N])
        X = np.random.rand(M, M)
        name = "M" + str(i + 1)
        data["params"][name] = pl.to_json(X)

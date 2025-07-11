# server.py
import random

def generate(data):
    size_limit = 20
    # randomly pick one of three concepts
    concept = random.choice(("prime", "even", "odd"))
    data["params"]["concept"] = concept

    # build the set of correct answers for the chosen concept
    if concept == "prime":
        # all primes up to (but not including) size_limit
        correct_set = {2, 3, 5, 7, 11, 13, 17, 19}
    elif concept == "even":
        correct_set = {n for n in range(1, size_limit) if n % 2 == 0}
    else:  # odd
        correct_set = {n for n in range(1, size_limit) if n % 2 != 0}

    # generate all options from 1 to size_limit–1, marking correct ones
    data["params"]["options"] = [
        {"correct": (n in correct_set), "answer": str(n)}
        for n in range(1, size_limit)
    ]

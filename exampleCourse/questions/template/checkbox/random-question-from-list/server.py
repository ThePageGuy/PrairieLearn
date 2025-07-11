import random

def generate(data):
    # define our categories and their items
    pools = {
        "vowels": ["a", "e", "i", "o", "u"],
        "primary colors": ["red", "blue", "yellow"],
        "continents": [
            "Africa", "Antarctica", "Asia", "Europe",
            "North America", "Oceania", "South America"
        ]
    }

    # pick one category at random
    topic = random.choice(list(pools.keys()))
    data["params"]["topic"] = topic

    # build the full answer list (union of all pools), in fixed order
    union_list = pools["vowels"] + pools["primary colors"] + pools["continents"]

    # mark correct items
    correct_set = set(pools[topic])
    data["params"]["options"] = [
        {"correct": (item in correct_set), "answer": item}
        for item in union_list
    ]

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.desired_capabilities import DesiredCapabilities
from time import sleep
from langdetect import detect
import json
import os
import pickle

COOKIES_FILE = "cookies.pkl"
CHROMEDRIVER_FILE = "chromedriver.exe"


def main():
    try:
        # Enable Performance Logging of Chrome.
        desired_capabilities = DesiredCapabilities.CHROME
        desired_capabilities["goog:loggingPrefs"] = {"performance": "ALL"}

        chrome_options = Options()
        chrome_options.add_argument("--ignore-certificate-errors")
        chrome_options.add_experimental_option("detach", True)

        driver = webdriver.Chrome(chrome_options=chrome_options,
                                  desired_capabilities=desired_capabilities)

        driver.get("https://bumble.com/app")
        sleep(2)
        initial_page_source = driver.page_source

        if os.path.exists(COOKIES_FILE):
            loadCookies(driver)
            driver.refresh()
        else:
            createCookies(driver)

        while driver.service.process:
            # get the current page source
            current_page_source = driver.page_source

            # check if the page source has changed
            if current_page_source != initial_page_source:
                getLikes(driver)
                initial_page_source = current_page_source

            sleep(1)
    except Exception as e:
        None


def getLikes(driver):
    sleep(2)
    logs = driver.get_log("performance")

    for log in logs:
        network_log = json.loads(log["message"])["message"]
        if("Network.response" in network_log["method"]):
            try:
                if("https://bumble.com/mwebapi.phtml?SERVER_GET_ENCOUNTERS" in network_log["params"]["response"]["url"]):
                    response = driver.execute_cdp_cmd('Network.getResponseBody', {
                        'requestId': network_log["params"]["requestId"]})['body']
            except:
                None

    try:
        response = json.loads(response)
        print("Number of results:", len(
            response['body'][0]['client_encounters']['results']))

        for user in response['body'][0]['client_encounters']['results']:
            name = user['user']['name']
            age = user['user']['age']
            # pic = user['user']['album']['photos'][0]['large_url'][2:]

            print("\t", name[::-1] if detect(name) == 'he' else name, "age:", age,
                  "is like you:", user['has_user_voted'])
    except:
        None


def createCookies(driver):
    while driver.current_url != "https://bumble.com/app":
        None

    pickle.dump(driver.get_cookies(), open(COOKIES_FILE, "wb"))


def loadCookies(driver):
    cookies = pickle.load(open(COOKIES_FILE, "rb"))

    for cookie in cookies:
        driver.add_cookie(cookie)


if __name__ == "__main__":
    if os.path.exists(CHROMEDRIVER_FILE):
        main()
    else:
        print("Please download the chromedriver from: https://chromedriver.chromium.org/downloads")

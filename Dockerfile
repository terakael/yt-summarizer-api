FROM python:3.11

RUN groupadd yt \
    && useradd -u 50000 -g yt yt

WORKDIR /home/yt
COPY src/. .

COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt

RUN chown -R yt:yt /home/yt
USER yt

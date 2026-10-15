FROM prairielearn/workspace-jupyterlab-base:latest
ARG CACHEBUST=2026-10-15-18-07-49

USER root
COPY install.sh requirements.txt /
RUN /bin/bash /install.sh

USER jovyan

# Tell Jupyter to hide the Python kernel
ENV HIDE_PYTHON_KERNEL=true

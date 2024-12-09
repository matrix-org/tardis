FROM python:3.12
COPY requirements-freeze.txt .
# don't use requirements.txt as it doesn't pin transitive deps
# twisted 24.10 breaks synapse as synapse is using `_encodeName` from twisted
# so stick with a frozen version which uses 24.7
RUN pip install -r requirements-freeze.txt
COPY shim.py shim.py
EXPOSE 1234
ARG COMMIT=unset
ENV COMMIT=${COMMIT}
CMD ["python", "shim.py"]
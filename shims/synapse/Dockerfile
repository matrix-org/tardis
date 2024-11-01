FROM python:3.12
COPY . .
# don't use requirements.txt as it doesn't pin transitive deps
# twisted 24.10 breaks synapse as synapse is using `_encodeName` from twisted
# so stick with a frozen version which uses 24.7
RUN pip install -r requirements-freeze.txt
EXPOSE 1234
CMD [ "python", "shim.py" ]